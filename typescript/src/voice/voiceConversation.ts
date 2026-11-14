import { VOICE_COMMANDS, type VoiceCommand, type VoiceProfile } from "./voiceCommands.js";
import type { VoiceQueryAnswer } from "./voiceQuery.js";
import type { VoiceSession } from "./voiceSession.js";

export type ConversationReason =
  | "provider-error"
  | "refused"
  | "rate-limited"
  | "too-long"
  | "reply-too-long"
  | "unavailable"
  | "timeout"
  | "tool-limit"
  | "ungrounded";

export type ConversationResult =
  | Readonly<{ status: "answered"; reply: string }>
  | Readonly<{ status: "unavailable"; reason: ConversationReason }>;

export type ConversationMessage = Readonly<{ role: "user" | "assistant"; content: string }>;

export type ConversationReasonerInput = Readonly<{
  transcript: string;
  profile: VoiceProfile;
  catalog: readonly VoiceCommand[];
  history: readonly ConversationMessage[];
  query: (commandId: string) => Promise<VoiceQueryAnswer>;
  reserveNextCall: () => boolean;
  signal?: AbortSignal;
}>;

export interface VoiceConversationReasoner {
  reply(input: ConversationReasonerInput): Promise<ConversationResult>;
}

type SessionContext = {
  profile: VoiceProfile;
  messages: ConversationMessage[];
  active: boolean;
  controller?: AbortController;
};

export type VoiceConversationOptions = Readonly<{
  reasoner: VoiceConversationReasoner;
  maxCallsPerHour?: number;
  maxUtteranceLength?: number;
  maxReplyLength?: number;
  historyLimit?: number;
  clock?: () => number;
}>;

/** Advisory, read-only conversation attached to existing voice sessions. */
export class VoiceConversationService {
  readonly #reasoner: VoiceConversationReasoner;
  readonly #maxCallsPerHour: number;
  readonly #maxUtteranceLength: number;
  readonly #maxReplyLength: number;
  readonly #historyLimit: number;
  readonly #clock: () => number;
  readonly #calls: number[] = [];
  readonly #contexts = new WeakMap<VoiceSession, SessionContext>();

  constructor(options: VoiceConversationOptions) {
    this.#reasoner = options.reasoner;
    this.#maxCallsPerHour = options.maxCallsPerHour ?? 120;
    this.#maxUtteranceLength = options.maxUtteranceLength ?? 500;
    this.#maxReplyLength = options.maxReplyLength ?? 600;
    this.#historyLimit = options.historyLimit ?? 12;
    this.#clock = options.clock ?? Date.now;
  }

  history(session: VoiceSession): readonly ConversationMessage[] {
    return [...(this.#contexts.get(session)?.messages ?? [])];
  }

  /** Abandon any in-flight reply for this session without dropping its history. */
  interrupt(session: VoiceSession): void {
    const context = this.#contexts.get(session);
    context?.controller?.abort();
    if (context) context.controller = undefined;
  }

  clear(session: VoiceSession): void {
    const context = this.#contexts.get(session);
    if (context) {
      context.active = false;
      context.controller?.abort();
    }
    this.#contexts.delete(session);
  }

  async respond(input: {
    session: VoiceSession;
    transcript: string;
    signal?: AbortSignal;
    live?: () => boolean;
  }): Promise<ConversationResult> {
    const { session, transcript } = input;
    if (transcript.length > this.#maxUtteranceLength) {
      return { status: "unavailable", reason: "too-long" };
    }
    let context = this.#contexts.get(session);
    if (!context || context.profile !== session.profile) {
      if (context) this.clear(session);
      context = { profile: session.profile, messages: [], active: true };
      this.#contexts.set(session, context);
    }
    if (context.controller) return { status: "unavailable", reason: "rate-limited" };
    if (input.signal?.aborted) return { status: "unavailable", reason: "unavailable" };
    if (!this.#reserveCall()) return { status: "unavailable", reason: "rate-limited" };
    const activeContext = context;
    const controller = new AbortController();
    activeContext.controller = controller;
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const catalog = VOICE_COMMANDS.filter((command) => command.profile === session.profile);
    const allowed = new Set(catalog.filter((command) => command.kind === "query").map((c) => c.id));
    const stillLive = () =>
      !signal.aborted &&
      activeContext.active &&
      this.#contexts.get(session) === activeContext &&
      session.profile === activeContext.profile &&
      input.live?.() !== false;
    // Every query attempt this turn and its outcome. Only a lone successful one can supply speech.
    const attempts: VoiceQueryAnswer[] = [];
    let result: ConversationResult;
    try {
      result = await this.#reasoner.reply({
        transcript,
        profile: session.profile,
        catalog,
        history: [...context.messages],
        query: async (commandId) => {
          let answer: VoiceQueryAnswer;
          if (!stillLive()) {
            answer = { status: "unavailable", reason: "Voice session unavailable." };
          } else if (!allowed.has(commandId)) {
            answer = { status: "unavailable", reason: "Voice query unavailable." };
          } else {
            answer = await session.readOnlyQuery(commandId);
          }
          attempts.push(answer);
          return answer;
        },
        reserveNextCall: () => stillLive() && this.#reserveCall(),
        signal,
      });
    } catch {
      result = { status: "unavailable", reason: "provider-error" };
    } finally {
      if (activeContext.controller === controller) activeContext.controller = undefined;
    }
    if (!stillLive()) return { status: "unavailable", reason: "unavailable" };
    // Attempt count outranks every reasoner outcome (provider-error, unavailable, order).
    if (attempts.length > 1) return { status: "unavailable", reason: "tool-limit" };
    if (result.status !== "answered") return result;
    const decision = speechDecision(attempts, this.#maxReplyLength);
    if (decision.status !== "answered") return decision;
    const reply = decision.reply;
    activeContext.messages.push(
      { role: "user", content: transcript },
      { role: "assistant", content: reply },
    );
    activeContext.messages.splice(
      0,
      Math.max(0, activeContext.messages.length - this.#historyLimit),
    );
    return decision;
  }

  #reserveCall(): boolean {
    const now = this.#clock();
    while (this.#calls.length && this.#calls[0]! <= now - 3_600_000) this.#calls.shift();
    if (this.#calls.length >= this.#maxCallsPerHour) return false;
    this.#calls.push(now);
    return true;
  }
}

/** Fixed reply when no authoritative query was made; the model's own text is never spoken. */
export const NOT_DONE_REPLY =
  "I haven't done anything. Ask a catalogue question or say a catalogue command.";

/**
 * The whole speech boundary. Model text is never spoken; it only chooses read-only queries.
 *
 * - No query attempted: the fixed NOT_DONE_REPLY.
 * - More than one attempt (the sequence is ambiguous): unavailable, `tool-limit`.
 * - The single attempt was unavailable or refused: unavailable, `unavailable`.
 * - One successful query: its exact answer, or unavailable `reply-too-long` when it exceeds
 *   `maxReplyLength`. An authoritative answer is never truncated or reworded.
 */
export function speechDecision(
  attempts: readonly VoiceQueryAnswer[],
  maxReplyLength: number,
): ConversationResult {
  if (attempts.length === 0) return { status: "answered", reply: NOT_DONE_REPLY };
  if (attempts.length > 1) return { status: "unavailable", reason: "tool-limit" };
  const only = attempts[0]!;
  if (only.status !== "answered") return { status: "unavailable", reason: "unavailable" };
  if (only.answer.length === 0) return { status: "unavailable", reason: "unavailable" };
  if (only.answer.length > maxReplyLength) {
    return { status: "unavailable", reason: "reply-too-long" };
  }
  return { status: "answered", reply: only.answer };
}
