import { VOICE_COMMANDS, type VoiceCommand, type VoiceProfile } from "./voiceCommands.js";
import type { VoiceQueryAnswer } from "./voiceQuery.js";
import type { VoiceSession } from "./voiceSession.js";

export type ConversationReason =
  | "provider-error"
  | "refused"
  | "rate-limited"
  | "too-long"
  | "unavailable"
  | "timeout"
  | "tool-limit";

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
    let result: ConversationResult;
    try {
      result = await this.#reasoner.reply({
        transcript,
        profile: session.profile,
        catalog,
        history: [...context.messages],
        query: async (commandId) => {
          if (
            signal.aborted ||
            !activeContext.active ||
            this.#contexts.get(session) !== activeContext ||
            input.live?.() === false
          ) {
            return { status: "unavailable", reason: "Voice session unavailable." };
          }
          if (!allowed.has(commandId))
            return { status: "unavailable", reason: "Voice query unavailable." };
          return session.readOnlyQuery(commandId);
        },
        reserveNextCall: () => !signal.aborted && activeContext.active && this.#reserveCall(),
        signal,
      });
    } catch {
      result = { status: "unavailable", reason: "provider-error" };
    } finally {
      if (activeContext.controller === controller) activeContext.controller = undefined;
    }
    if (
      !activeContext.active ||
      this.#contexts.get(session) !== activeContext ||
      session.profile !== activeContext.profile ||
      signal.aborted ||
      input.live?.() === false
    ) {
      return { status: "unavailable", reason: "unavailable" };
    }
    if (result.status !== "answered") return result;
    const reply = spokenReply(result.reply, this.#maxReplyLength);
    if (!reply) return { status: "unavailable", reason: "provider-error" };
    activeContext.messages.push(
      { role: "user", content: transcript },
      { role: "assistant", content: reply },
    );
    activeContext.messages.splice(
      0,
      Math.max(0, activeContext.messages.length - this.#historyLimit),
    );
    return { status: "answered", reply };
  }

  #reserveCall(): boolean {
    const now = this.#clock();
    while (this.#calls.length && this.#calls[0]! <= now - 3_600_000) this.#calls.shift();
    if (this.#calls.length >= this.#maxCallsPerHour) return false;
    this.#calls.push(now);
    return true;
  }
}

export function spokenReply(raw: string, limit: number): string {
  const text = raw.trim();
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  const sentenceEnd = Math.max(
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("? "),
    prefix.lastIndexOf("! "),
  );
  if (sentenceEnd >= 0) return prefix.slice(0, sentenceEnd + 1).trim();
  const wordEnd = prefix.lastIndexOf(" ");
  return `${(wordEnd > 0 ? prefix.slice(0, wordEnd) : prefix.slice(0, limit - 1)).trim()}.`;
}
