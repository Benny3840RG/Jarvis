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
    // Only answers the server itself returned this turn may ground figures in the reply.
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
    const trimmed = spokenReply(result.reply, this.#maxReplyLength);
    if (!trimmed) return { status: "unavailable", reason: "provider-error" };
    // Deterministic guards: the model has no authority, so it may never claim an action, and
    // it may only repeat figures that a successful read-only query returned this turn.
    if (!figuresGrounded(trimmed, groundedAnswers))
      return { status: "unavailable", reason: "ungrounded" };
    const reply =
      claimsAction(trimmed) || claimsUngroundedOutcome(trimmed, groundedAnswers)
        ? NOT_DONE_REPLY
        : trimmed;
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

export const NOT_DONE_REPLY =
  "I haven't done anything. Say the catalogue command when you want it done.";

const ACTION_VERBS =
  "sent|send|sending|approved|approve|approving|confirmed|confirm|confirming|staged|stage|" +
  "added|add|adding|created|create|creating|scheduled|schedule|booked|book|cancell?ed|cancel|" +
  "started|start|starting|stopped|stop|stopping|moved|move|deleted|delete|paid|pay|emailed|" +
  "email|actioned|updated|update|logged|log|set|turned|switched|raised|lowered|recorded|" +
  "saved|done|completed|finished|lodged|submitted|submit|issued|issue|queued|queue|arranged|" +
  "organised|organized|reminded|remind|notified|notify|texted|called|rang|ordered|order";
const ACTION_CLAIM = new RegExp(
  String.raw`\b(?:i|we)(?:'ve|'ll|'m| have| will| am| just| now| already)*\s+` +
    String.raw`(?:just\s+|now\s+|already\s+|gone ahead and\s+|went ahead and\s+|going to\s+)*` +
    String.raw`(?:${ACTION_VERBS})\b|\b(?:that's|that is|it's|it is|all|that has been|it has been)` +
    String.raw`\s+(?:now\s+)?(?:done|sent|sorted|booked|` +
    String.raw`approved|confirmed|staged|scheduled|cancell?ed|added|created|paid|lodged|actioned)\b`,
  "i",
);

/** True when the reply asserts or promises an action the conversation cannot perform. */
export function claimsAction(reply: string): boolean {
  return ACTION_CLAIM.test(reply.replace(/[\u2018\u2019]/g, "'"));
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  dozen: 12,
  couple: 2,
};
const NUMBER_WORD = `(?:${[...Object.keys(NUMBER_WORDS), "hundred", "thousand", "million", "billion"].join("|")})`;
const NUMBER_PHRASE = new RegExp(
  String.raw`\b${NUMBER_WORD}(?:(?:[\s-]+and)?[\s-]+${NUMBER_WORD})*\b`,
  "gi",
);

/** Rewrite spelled-out numbers ("twenty five") as digits so words cannot evade the guard. */
function digitiseNumberWords(text: string): string {
  return text.replace(NUMBER_PHRASE, (phrase, offset: number) => {
    const words = phrase
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((w) => w !== "and");
    // A pronoun-style "one" ("that one", "one of them", "one sentence") is not a figure.
    if (words.length === 1 && words[0] === "one") {
      const next = /^\s+([a-z]+)/i.exec(text.slice(offset + phrase.length))?.[1]?.toLowerCase();
      const prev = /([a-z]+)\s+$/i.exec(text.slice(0, offset))?.[1]?.toLowerCase();
      if (
        !next ||
        PRONOUN_ONE_NEXT.has(next) ||
        (prev !== undefined && PRONOUN_ONE_PREV.has(prev))
      ) {
        return phrase;
      }
    }
    let total = 0;
    let current = 0;
    for (const word of words) {
      if (word === "hundred") current = (current || 1) * 100;
      else if (word === "thousand" || word === "million" || word === "billion") {
        const scale = word === "thousand" ? 1e3 : word === "million" ? 1e6 : 1e9;
        total += (current || 1) * scale;
        current = 0;
      } else if (word === "dozen") current = (current || 1) * 12;
      else current += NUMBER_WORDS[word] ?? 0;
    }
    return String(total + current);
  });
}

const PRONOUN_ONE_NEXT = new Set([
  "of",
  "more",
  "moment",
  "thing",
  "that",
  "for",
  "to",
  "sentence",
]);
const PRONOUN_ONE_PREV = new Set(["the", "that", "this", "which", "any", "each", "every", "no"]);
const CURRENCY_WORDS = /^\s*(?:dollars?|bucks|pounds?|euros?|cents?|quid)\b/i;

/** A figure plus its semantic unit class, so "3 unpaid invoices" never grounds "$3". */
function quantities(text: string): string[] {
  const normal = digitiseNumberWords(text);
  const found: string[] = [];
  for (const match of normal.matchAll(/([$€£¥])?\s?(\d[\d,.:/-]*\d|\d)/g)) {
    const value = match[2]!.replace(/,/g, "");
    const after = normal.slice(match.index + match[0].length);
    const unit =
      match[1] || CURRENCY_WORDS.test(after)
        ? "money"
        : /^\s*(?:%|percent\b)/i.test(after)
          ? "percent"
          : /[:/-]/.test(value)
            ? "formatted"
            : "count";
    found.push(`${unit}:${value}`);
  }
  return found;
}

/** Every figure (value and unit class) in the reply must come from a query answer this turn. */
export function figuresGrounded(reply: string, answers: readonly string[]): boolean {
  const known = new Set(answers.flatMap(quantities));
  const replyQuantities = quantities(reply);
  if (!replyQuantities.length) {
    return !/[$€£¥]/.test(reply) || answers.some((a) => /[$€£¥]/.test(a));
  }
  return replyQuantities.every((q) => known.has(q));
}

const PARTICIPLE =
  "\\w{3,}ed|sent|done|made|set|paid|put|sold|given|taken|got|left|built|cut|shut|bought|brought";
const PASSIVE_CLAIM = new RegExp(
  String.raw`\b(?:(?:has|have|had)\s+(?:(?:now|already|just|successfully)\s+)*been|` +
    String.raw`(?:is|are|was|were|got|gets)\s+(?:(?:now|already|just|successfully)\s+)*)` +
    String.raw`\s*(${PARTICIPLE})\b`,
  "gi",
);

/**
 * True when the reply uses a passive completion form ("has been sent", "is booked") whose
 * participle no query answer this turn used. Reading an existing state back is fine;
 * announcing an outcome nothing produced is not.
 */
export function claimsUngroundedOutcome(reply: string, answers: readonly string[]): boolean {
  const known = new Set(answers.flatMap((a) => a.toLowerCase().match(/[a-z]+/g) ?? []));
  const text = reply.replace(/[\u2018\u2019]/g, "'").replace(/'s\b/g, " is");
  for (const match of text.matchAll(PASSIVE_CLAIM)) {
    if (!known.has(match[1]!.toLowerCase())) return true;
  }
  return false;
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
