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
    // Authoritative answers the server itself returned this turn; they are what gets spoken.
    const groundedAnswers: string[] = [];
    let result: ConversationResult;
    try {
      result = await this.#reasoner.reply({
        transcript,
        profile: session.profile,
        catalog,
        history: [...context.messages],
        query: async (commandId) => {
          if (!stillLive()) {
            return { status: "unavailable", reason: "Voice session unavailable." };
          }
          if (!allowed.has(commandId))
            return { status: "unavailable", reason: "Voice query unavailable." };
          const answer = await session.readOnlyQuery(commandId);
          if (answer.status === "answered") groundedAnswers.push(answer.answer);
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
    if (result.status !== "answered") return result;
    const reply = spokenReply(boundedSpeech(result.reply, groundedAnswers), this.#maxReplyLength);
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

/** Fixed reply when the model made no authoritative query and offered nothing demonstrably safe. */
export const NOT_DONE_REPLY =
  "I haven't done anything. Ask a catalogue question or say a catalogue command.";

/**
 * The whole speech boundary, deliberately not semantic:
 *
 * 1. If any read-only query answered this turn, the model's text is discarded and the exact
 *    authoritative answer(s), in query order, are spoken. The model only chooses which query.
 * 2. Otherwise the model's text is spoken only if it is a bare greeting or a single short
 *    question (see `isPlainGreeting` / `isPlainQuestion`); anything else becomes NOT_DONE_REPLY.
 *    Questions and greetings cannot assert a fact, status, amount or outcome by construction.
 */
export function boundedSpeech(modelText: string, answers: readonly string[]): string {
  if (answers.length > 0) return [...new Set(answers)].join(" ");
  const text = modelText.trim().replace(/\s+/g, " ");
  return isPlainGreeting(text) || isPlainQuestion(text) ? text : NOT_DONE_REPLY;
}

const GREETING = /^(?:hello|hi|hey|good (?:morning|afternoon|evening))[.!]?$/i;
// Closed set of interrogative openers; a reply starting with one is asking, not telling.
const QUESTION_OPENER =
  /^(?:which|what|when|who|whom|whose|where|how|do|does|did|can|could|would|should|shall|will|is|are|was|were|have|has)\b/i;

/** A bare greeting and nothing else. */
export function isPlainGreeting(text: string): boolean {
  return GREETING.test(text);
}

/**
 * One short question: interrogative opener, a single "?" at the very end, no digits or currency
 * and no punctuation or conjunction that could chain a second clause before the question mark.
 */
export function isPlainQuestion(text: string): boolean {
  return (
    text.length <= 100 &&
    QUESTION_OPENER.test(text) &&
    /^[A-Za-z' ]+\?$/.test(text) &&
    !/\b(?:and|but|so|then|because|since|while|although)\b/i.test(text)
  );
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
