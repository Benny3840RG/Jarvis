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
const STOP_WORDS = new Set(
  (
    "a an the and or but so of to in on at by for with from as is are was were be been being am " +
    "has have had do does did you your yours i me my we our they them their it its this that " +
    "these those there here which who what when how then than also just now already still " +
    "not no can could will would should may might must"
  ).split(" "),
);
const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  $: "dollar",
  "€": "euro",
  "£": "pound",
  "¥": "yen",
};
// Past/perfect forms that do not end in "-ed". Fixed, tiny, and only used to *find* claims;
// the decision is always "same clause grounded in a source sentence", never an allowlist.
const IRREGULAR_PAST = new Set(
  (
    "been gone went done did made sent paid put sold given gave taken took got left built cut " +
    "shut bought brought begun began came run ran won lost kept held told said set"
  ).split(" "),
);

type Token = { readonly text: string; readonly numeric: boolean };

/** Lower-cased words and numbers; digits for number words, currency symbols as unit words. */
function tokenise(text: string): Token[] {
  const normal = digitiseNumberWords(text.replace(/[\u2018\u2019]/g, "'"))
    .replace(
      /([$€£¥])\s?(\d[\d,.]*\d|\d)/g,
      (_m, c: string, n: string) => `${n} ${CURRENCY_NAMES[c]}`,
    )
    .replace(/%/g, " percent ");
  const out: Token[] = [];
  for (const m of normal.toLowerCase().matchAll(/\d[\d,.:/-]*\d|\d|[a-z]+/g)) {
    const numeric = /^\d/.test(m[0]);
    out.push({ text: numeric ? m[0].replace(/,/g, "") : stem(m[0]), numeric });
  }
  return out;
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

const SIGNIFICANT = (t: Token) => t.numeric || !STOP_WORDS.has(t.text);
const WINDOW = 3;

/**
 * Each figure with the words around it (up to WINDOW significant words each side, stopping at
 * a neighbouring figure), so a number stays bound to its entity and unit.
 */
function figureContexts(text: string): Array<{ value: string; words: Set<string> }> {
  return splitClauses(text).flatMap(clauseFigureContexts);
}

/** Punctuation ends a clause only before whitespace, so "1,000" and "3.5" stay whole. */
function splitClauses(text: string): string[] {
  return text.split(/[.!?;:,]+(?=\s|$)|\n|\b(?:and|but|so|then)\b/i);
}

function clauseFigureContexts(clause: string): Array<{ value: string; words: Set<string> }> {
  const tokens = tokenise(clause).filter(SIGNIFICANT);
  const found: Array<{ value: string; words: Set<string> }> = [];
  tokens.forEach((token, index) => {
    if (!token.numeric) return;
    const words = new Set<string>();
    for (const step of [-1, 1]) {
      for (
        let i = index + step, n = 0;
        n < WINDOW && tokens[i] && !tokens[i]!.numeric;
        i += step, n++
      )
        words.add(tokens[i]!.text);
    }
    found.push({ value: token.text, words });
  });
  return found;
}

/**
 * Every figure in the reply must match a figure in a query answer from this turn with the same
 * value, and the reply's words around it must all occur around that same source figure. A
 * figure with no surrounding words is rejected: it is detached from any fact.
 */
export function figuresGrounded(reply: string, answers: readonly string[]): boolean {
  const known = answers.flatMap(figureContexts);
  return figureContexts(reply).every(
    (figure) =>
      figure.words.size > 0 &&
      known.some(
        (source) =>
          source.value === figure.value && [...figure.words].every((w) => source.words.has(w)),
      ),
  );
}

function isOutcomeWord(token: Token): boolean {
  if (token.numeric) return false;
  return (
    IRREGULAR_PAST.has(token.text) ||
    (token.text.length > 3 && token.text.endsWith("ed") && !token.text.endsWith("eed"))
  );
}

function clauses(text: string): Token[][] {
  return splitClauses(text)
    .map((c) => tokenise(c))
    .filter((c) => c.length > 0);
}

/**
 * Fail-closed invariant: the conversation never acts, so any clause that reads as a completed
 * event (past/perfect/passive) must be fully covered, subject and object included, by one clause
 * of a read-only answer returned this turn. "Your quote has gone out" and "3 invoices were sent"
 * -> "Your quote was sent" are both rejected: the clause is not inside a source clause.
 */
export function claimsUngroundedOutcome(reply: string, answers: readonly string[]): boolean {
  const sources = answers.flatMap((a) =>
    clauses(a).map((c) => new Set(c.filter((t) => !t.numeric).map((t) => t.text))),
  );
  return clauses(reply).some((clause) => {
    if (!clause.some(isOutcomeWord)) return false;
    const words = clause.filter((t) => !t.numeric && !STOP_WORDS.has(t.text));
    return !sources.some((source) => words.every((w) => source.has(w.text)));
  });
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
