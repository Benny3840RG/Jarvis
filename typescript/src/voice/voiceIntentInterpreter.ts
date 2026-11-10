/**
 * Jarvis voice — natural-language intent interpreter (Wave One, #567).
 *
 * WHAT THIS IS. A deterministic, dependency-free layer that sits *ahead of* the
 * guarded parser's deterministic action boundary. Given a final transcript and
 * the active profile, it PROPOSES which catalog command the speaker most likely
 * means, with a confidence and an explicit "needs clarification" outcome. It is
 * the first increment of the natural contextual understanding the deterministic
 * exact-matcher cannot provide.
 *
 * WHAT THIS IS NOT — and the safety contract that makes it safe to add:
 *   - It NEVER dispatches, approves, actuates or executes. It returns a
 *     proposal and nothing else; there is no code path from here to an effect.
 *   - It is NOT wired into `voiceParser.ts`, `voiceSession.ts` or any live
 *     path. Final-only, whole-utterance exact dispatch remains the sole gate.
 *     A proposal is advisory context a caller may surface or confirm; it can
 *     never substitute for the deterministic boundary or for governed approval.
 *   - It FAILS CLOSED: it abstains (proposes nothing) on genuine ambiguity, on
 *     conflicting recogniser hypotheses, and on negated requests; and it never
 *     proposes a command outside the active profile. In particular it will not
 *     propose a critical/actuating command from a negated utterance.
 *
 * It is a lexical/heuristic interpreter, not a learned model — deliberately, so
 * it is pure and fully testable. The `InterpretedIntent` shape is the stable
 * contract; a model-backed implementation could later sit behind it unchanged.
 *
 * Evidence: `docs/evidence/voice-intent-baseline-2026-11-10.md` reports the
 * measured coverage improvement over the exact-matcher and confirms zero unsafe
 * proposals across the adversarial set.
 */

import {
  VOICE_COMMANDS,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";

export type InterpretInput = Readonly<{
  /** The transcript to interpret. */
  transcript: string;
  profile: VoiceProfile;
  /**
   * Whether the transcript is final. Defaults to true. When explicitly false
   * the interpreter withholds any proposal — defence in depth, so even a caller
   * that forgets the final-only rule cannot surface an interim intent.
   */
  isFinal?: boolean;
  /** Lower-confidence recogniser alternatives, if any. */
  alternatives?: readonly string[];
}>;

export type InterpretedIntent =
  /** A single catalog command is the most likely intent. Advisory only. */
  | Readonly<{
      status: "proposed";
      commandId: string;
      confidence: number;
      /** For an actuate/critical command, a caller must still confirm + exact-dispatch. */
      requiresConfirmation: boolean;
      rationale: string;
    }>
  /** A command is plausibly meant but the layer will not guess which. */
  | Readonly<{ status: "needs-clarification"; candidates: readonly string[]; rationale: string }>
  /** No catalog intent is discernible. */
  | Readonly<{ status: "no-intent"; rationale: string }>;

/** A group matches when any of its alternatives is present (see `groupMatches`). */
type Group = readonly string[];
/** A pattern matches when every one of its groups matches. */
type Pattern = readonly Group[];

type Signal = Readonly<{ commandId: string; profile: VoiceProfile; patterns: readonly Pattern[] }>;

const COMMAND_BY_ID: ReadonlyMap<string, VoiceCommand> = new Map(
  VOICE_COMMANDS.map((command) => [command.id, command]),
);

/**
 * Explicit negation markers. Withhold rather than infer which clause is negated.
 *
 * `hasnt`/`havent` are deliberately NOT here: they are polarity-bearing but
 * query-specific, handled separately via `QUERY_EXEMPT_NEGATION_TOKENS` so a
 * legitimate read-only query may use them while a guarded command still fails
 * closed. See that set's note.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "dont",
  "never",
  "without",
  "wont",
  "cant",
  "cannot",
  "neither",
  "shouldnt",
  "wouldnt",
  "couldnt",
  "didnt",
  // Negative contractions of the command verb: "the winch isn't going up".
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "aint",
  "doesnt",
  "hadnt",
  "mustnt",
]);

/**
 * Explicit retraction markers. A speaker who says "forget the winch up" or
 * "cancel that ramp deploy" is withdrawing the command, not issuing it, so the
 * layer fails closed exactly as it does for negation. Kept to unambiguous
 * retraction verbs so ordinary conversation is not suppressed.
 */
const RETRACTION_TOKENS: ReadonlySet<string> = new Set([
  "forget",
  "cancel",
  "nevermind",
  "disregard",
  "scrap",
  "belay",
  "abort",
  "scratch",
]);

/**
 * Negation contractions of "has"/"have" ("hasn't", "haven't"). These are NOT a
 * blanket negation: a read-only query legitimately uses them — "any invoices
 * that haven't been paid" is the unpaid-invoices query — so banning them
 * outright would suppress a legitimate intent. The exemption is therefore
 * QUERY-SPECIFIC: they withhold exactly like any other negation when the matched
 * command is guarded (actuate/critical), and are tolerated only for non-guarded
 * queries. This closes the previous leak where "the winch hasn't gone up"
 * proposed the guarded winch-up and "I haven't sent the quote" proposed the
 * critical send-quote.
 */
const QUERY_EXEMPT_NEGATION_TOKENS: ReadonlySet<string> = new Set(["hasnt", "havent"]);

/** Connectors that join two separate requests into a compound utterance. */
const COMPOUND_CONNECTORS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "then",
  "also",
  "plus",
  "after",
  "before",
]);

/** Lexical signals per command. Profile is implicit context, so phrasings need
 * not repeat the profile noun. Each pattern lists the token groups that must
 * all be present; more specific (more-group) patterns win ties. */
const SIGNALS: readonly Signal[] = [
  // ── Crawler ──
  sig("crawler.status", "crawler", [["status", "how", "hows", "check", "doing"], ["crawler"]]),
  sig("crawler.forward", "crawler", [["crawler"], ["forward", "forwards", "ahead", "advance"]]),
  sig("crawler.reverse", "crawler", [
    ["crawler"],
    ["reverse", "back", "backward", "backwards", "backup"],
  ]),
  sig("crawler.stop", "crawler", [["crawler"], ["stop", "halt", "pull", "whoa"]]),
  sig("crawler.lights-on", "crawler", [["crawler"], ["light", "lights"], ["on"]]),
  sig("crawler.lights-off", "crawler", [["crawler"], ["light", "lights"], ["off", "out", "kill"]]),
  sig("crawler.record-start", "crawler", [
    ["crawler"],
    ["record", "recording"],
    ["start", "begin", "roll"],
  ]),
  sig("crawler.record-stop", "crawler", [
    ["crawler"],
    ["record", "recording"],
    ["stop", "end", "finish"],
  ]),
  // ── Workshop ──
  sig("workshop.status", "workshop", [["status", "how", "hows"], ["workshop"]]),
  sig("workshop.next-job", "workshop", [["next"], ["job", "jobs", "up", "on"]]),
  sig("workshop.lights-on", "workshop", [["light", "lights"], ["on"]]),
  sig("workshop.lights-off", "workshop", [
    ["light", "lights"],
    ["off", "out", "kill"],
  ]),
  sig("workshop.compressor-on", "workshop", [
    ["compressor"],
    ["start", "fire", "kick", "on", "up"],
  ]),
  sig("workshop.compressor-off", "workshop", [
    ["compressor"],
    ["stop", "kill", "off", "shut", "down"],
  ]),
  sig("workshop.builds", "workshop", [
    ["build", "builds"],
    ["workshop", "show", "list", "on"],
  ]),
  sig("workshop.assets", "workshop", [
    ["asset", "assets"],
    ["workshop", "show", "list", "got", "have"],
  ]),
  sig("workshop.maintenance", "workshop", [
    ["maintenance", "service", "servicing"],
    ["due", "workshop", "need"],
  ]),
  sig("workshop.log-note", "workshop", [
    ["note"],
    ["log", "jot", "make", "workshop", "write", "add"],
  ]),
  // ── Trailer ──
  sig("trailer.status", "trailer", [["status", "how", "hows"], ["trailer"]]),
  sig("trailer.lights-on", "trailer", [["light", "lights"], ["on"]]),
  sig("trailer.lights-off", "trailer", [
    ["light", "lights"],
    ["off", "out", "kill"],
  ]),
  sig("trailer.winch-up", "trailer", [["winch"], ["up", "raise", "lift"]]),
  sig("trailer.winch-down", "trailer", [["winch"], ["down", "lower", "drop"]]),
  sig("trailer.ramp-deploy", "trailer", [["ramp"], ["deploy", "down", "drop", "out", "lower"]]),
  sig("trailer.ramp-stow", "trailer", [["ramp"], ["stow", "up", "away", "pack", "stowed"]]),
  // ── Client ──
  sig("client.todays-schedule", "client", [
    ["today", "todays"],
    ["schedule", "on", "got", "doing", "whats", "what"],
  ]),
  sig("client.next-appointment", "client", [
    ["appointment", "appo", "appt"],
    ["next", "when", "whens"],
  ]),
  sig("client.jobs-this-week", "client", [["week"], ["job", "jobs", "on", "whats", "got"]]),
  sig("client.unpaid-invoices", "client", [
    ["invoice", "invoices"],
    ["unpaid", "outstanding", "owing", "owe", "any"],
  ]),
  sig("client.open-enquiries", "client", [
    ["enquiry", "enquiries", "enquires", "lead", "leads"],
    ["any", "new", "open"],
  ]),
  sig("client.quote-follow-up", "client", [
    ["quote", "quotes"],
    ["follow", "chase", "awaiting", "followup"],
  ]),
  sig("client.open-tasks", "client", [
    ["task", "tasks"],
    ["open", "my", "list", "got", "whats"],
  ]),
  sig("client.reminders", "client", [
    ["reminder", "reminders"],
    ["any", "my", "got", "whats", "have"],
  ]),
  sig("client.open-errands", "client", [
    ["errand", "errands"],
    ["open", "any", "run", "list", "whats"],
  ]),
  sig("client.draft-quote", "client", [
    ["quote"],
    ["draft", "whip", "draw", "start", "prepare", "do", "new"],
  ]),
  sig("client.send-quote", "client", [["quote"], ["send", "fire", "shoot", "dispatch", "sent"]]),
  sig("client.follow-up-reminder", "client", [
    ["remind", "reminder"],
    ["follow", "chase", "followup"],
  ]),
  sig("client.capture-task", "client", [
    ["task"],
    ["add", "new", "capture", "chuck", "create", "make"],
  ]),
  sig("client.capture-errand", "client", [
    ["errand"],
    ["add", "new", "capture", "put", "create", "make"],
  ]),
];

function sig(commandId: string, profile: VoiceProfile, ...patterns: Pattern[]): Signal {
  return { commandId, profile, patterns };
}

/**
 * Normalise then strip apostrophes so "what's"→"whats", "don't"→"dont". Also
 * reports whether the utterance is compound — two requests joined by a connector
 * word or a comma. The comma must be read here, before punctuation is stripped
 * for tokenisation, so "crawler forward, lights on" is still seen as compound.
 */
function tokenize(raw: string): { tokens: readonly string[]; joined: string; compound: boolean } {
  const normalized = normalizeUtterance(raw).replace(/['’]/g, "");
  const hasComma = normalized.includes(",");
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const compound = hasComma || tokens.some((token) => COMPOUND_CONNECTORS.has(token));
  return { tokens, joined: tokens.join(" "), compound };
}

/**
 * True when `a` and `b` are within a single edit (substitution, insertion or
 * deletion). Used only as a bounded tolerance for speech-recognition slips
 * ("statue"→"status", "ram"→"ramp"). Restricted by the caller to tokens of
 * length ≥ 4, so short polarity words ("on"/"off"/"up"/"down") are never fuzzed
 * and a reversal of meaning can never slip through.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  if (long.length === short.length) {
    let diffs = 0;
    for (let i = 0; i < long.length; i += 1) if (long[i] !== short[i]) diffs += 1;
    return diffs === 1;
  }
  // One insertion/deletion: skip exactly one char in `long` and compare.
  for (let skip = 0; skip < long.length; skip += 1) {
    const candidate = long.slice(0, skip) + long.slice(skip + 1);
    if (candidate === short) return true;
  }
  return false;
}

/** A single-word alt may match a token fuzzily only when both are ≥ 4 chars. */
function tokenMatches(
  alt: string,
  tokens: readonly string[],
  tokenSet: ReadonlySet<string>,
  fuzzy: boolean,
): boolean {
  if (tokenSet.has(alt)) return true;
  if (!fuzzy || alt.length < 4) return false;
  return tokens.some((token) => token.length >= 4 && withinOneEdit(token, alt));
}

function groupMatches(
  group: Group,
  tokens: readonly string[],
  tokenSet: ReadonlySet<string>,
  joined: string,
  fuzzy: boolean,
): boolean {
  return group.some((alt) =>
    alt.includes(" ") ? joined.includes(alt) : tokenMatches(alt, tokens, tokenSet, fuzzy),
  );
}

type Candidate = Readonly<{ commandId: string; score: number }>;

function bestCandidate(
  profile: VoiceProfile,
  tokens: readonly string[],
  fuzzy: boolean,
): Candidate[] {
  const tokenSet = new Set(tokens);
  const joined = tokens.join(" ");
  const byCommand = new Map<string, number>();
  for (const signal of SIGNALS) {
    if (signal.profile !== profile) continue;
    let best = 0;
    for (const pattern of signal.patterns) {
      if (pattern.every((group) => groupMatches(group, tokens, tokenSet, joined, fuzzy))) {
        best = Math.max(best, pattern.length);
      }
    }
    if (best > 0) byCommand.set(signal.commandId, best);
  }
  return [...byCommand.entries()]
    .map(([commandId, score]) => ({ commandId, score }))
    .sort((a, b) => b.score - a.score);
}

/** A hard negation or explicit retraction; either always withholds (fail closed). */
function hasHardPolarity(tokens: readonly string[]): boolean {
  return tokens.some((t) => NEGATION_TOKENS.has(t) || RETRACTION_TOKENS.has(t));
}

/** The query-exempt has/have contractions, independent of hard polarity. */
function hasQueryExemptNegation(tokens: readonly string[]): boolean {
  return tokens.some((t) => QUERY_EXEMPT_NEGATION_TOKENS.has(t));
}

/** Any polarity marker at all, including the query-exempt has/have contractions. */
function hasAnyPolarity(tokens: readonly string[]): boolean {
  return hasHardPolarity(tokens) || hasQueryExemptNegation(tokens);
}

/** Strip every polarity marker, leaving the bare request clause. */
function stripPolarity(tokens: readonly string[]): readonly string[] {
  return tokens.filter(
    (t) =>
      !NEGATION_TOKENS.has(t) && !RETRACTION_TOKENS.has(t) && !QUERY_EXEMPT_NEGATION_TOKENS.has(t),
  );
}

function isGuarded(command: VoiceCommand): boolean {
  return command.kind === "actuate" || command.criticality === "critical";
}

function proposalFor(
  tokens: readonly string[],
  profile: VoiceProfile,
  fuzzy: boolean,
  compound: boolean,
): InterpretedIntent {
  const ranked = bestCandidate(profile, tokens, fuzzy);
  if (ranked.length === 0) {
    return { status: "no-intent", rationale: "no catalog signal matched in the active profile" };
  }

  // Polarity. A hard negation or explicit retraction always withholds. The
  // has/have contractions withhold too, but only when a matched command is
  // guarded (actuate/critical): a non-guarded query ("invoices that haven't
  // been paid") stays a legitimate proposal.
  if (hasHardPolarity(tokens)) {
    return { status: "no-intent", rationale: "explicit negation or retraction; no proposal" };
  }
  if (hasQueryExemptNegation(tokens)) {
    const anyGuarded = ranked.some((c) => isGuarded(COMMAND_BY_ID.get(c.commandId)!));
    if (anyGuarded) {
      return {
        status: "no-intent",
        rationale: "negated has/have contraction over a guarded command; no proposal",
      };
    }
  }

  const top = ranked[0]!;
  const contenders = compound
    ? ranked
    : ranked.filter((candidate) => candidate.score === top.score);
  if (contenders.length > 1) {
    return {
      status: "needs-clarification",
      candidates: Object.freeze(contenders.map((c) => c.commandId).sort()),
      rationale: compound
        ? "multiple commands in a compound utterance"
        : "multiple commands match equally well",
    };
  }

  const command = COMMAND_BY_ID.get(top.commandId)!;
  let confidence = Math.min(
    1,
    0.55 + 0.15 * top.score + (top.score - (ranked[1]?.score ?? 0)) * 0.1,
  );
  // A fuzzy (recognition-tolerant) match is inherently less certain.
  if (fuzzy) confidence = Math.min(confidence, 0.7);
  return {
    status: "proposed",
    commandId: top.commandId,
    confidence: Number(confidence.toFixed(2)),
    requiresConfirmation: isGuarded(command),
    rationale: `matched ${top.score} intent group(s) for ${top.commandId}${fuzzy ? " (recognition-tolerant)" : ""}`,
  };
}

/**
 * Resolve a proposal exact-first: fuzzy recognition tolerance is only consulted
 * when exact matching finds no intent at all, so it can never override or weaken
 * an exact decision (including an exact fail-closed one).
 */
function resolveProposal(
  tokens: readonly string[],
  profile: VoiceProfile,
  compound: boolean,
): InterpretedIntent {
  const exact = proposalFor(tokens, profile, false, compound);
  if (exact.status === "no-intent") {
    return proposalFor(tokens, profile, true, compound);
  }
  // A compound utterance may hide a second request whose verb was mis-recognised
  // ("wench up then turn lights on" — exact matching sees only lights-on). Re-run
  // with recognition tolerance; if the slipped request surfaces as a second
  // command, fail closed to clarification rather than propose the lone exact one.
  if (compound) {
    const tolerant = proposalFor(tokens, profile, true, compound);
    if (tolerant.status === "needs-clarification") return tolerant;
  }
  return exact;
}

/**
 * Interpret a final transcript into a proposed catalog intent. Advisory only —
 * see the safety contract in the file header. Conflicting recogniser
 * hypotheses (the top transcript and an alternative pointing to different
 * commands) fail closed to `needs-clarification`, mirroring the guarded parser.
 */
export function interpretIntent(input: InterpretInput): InterpretedIntent {
  // Fail closed on interim transcripts: never propose from partial speech.
  if (input.isFinal === false) {
    return { status: "no-intent", rationale: "interim transcript withheld (final-only)" };
  }

  const primaryTokens = tokenize(input.transcript);
  const primary = resolveProposal(primaryTokens.tokens, input.profile, primaryTokens.compound);

  const alternatives = input.alternatives ?? [];
  if (alternatives.length === 0 || primary.status !== "proposed") {
    return primary;
  }

  // An alternative that resolves to a different command casts doubt: fail closed.
  // Alternatives use exact matching only, so recognition noise cannot manufacture
  // a spurious conflict.
  const conflicting = new Set<string>([primary.commandId]);
  for (const alternative of alternatives) {
    const altTokens = tokenize(alternative);
    // A negated/retracted alternative ("don't winch up") means the recogniser is
    // unsure whether the speaker negated the command. If the negated clause still
    // references a catalog command, fail closed rather than trust the primary.
    // Query-specific has/have contractions are not negation when the
    // alternative itself resolves to the same non-guarded query.
    const altExact = proposalFor(altTokens.tokens, input.profile, false, altTokens.compound);
    const agreedQuery =
      !hasHardPolarity(altTokens.tokens) &&
      altExact.status === "proposed" &&
      altExact.commandId === primary.commandId &&
      !isGuarded(COMMAND_BY_ID.get(primary.commandId)!);
    if (hasAnyPolarity(altTokens.tokens) && !agreedQuery) {
      const bare = stripPolarity(altTokens.tokens);
      // Resolve the bare clause exact-first then recognition-tolerant, mirroring
      // how the primary was resolved. A negated ASR slip ("don't wench up"
      // against a recognition-tolerant "wench up" primary) must fail closed, not
      // slip through because the bare clause only matched fuzzily.
      if (resolveProposal(bare, input.profile, altTokens.compound).status !== "no-intent") {
        return {
          status: "needs-clarification",
          candidates: Object.freeze([primary.commandId]),
          rationale: "a recogniser alternative negates or retracts the proposed command",
        };
      }
      continue;
    }
    const alt = proposalFor(altTokens.tokens, input.profile, false, altTokens.compound);
    if (alt.status === "proposed") conflicting.add(alt.commandId);
    if (alt.status === "needs-clarification") {
      for (const candidate of alt.candidates) conflicting.add(candidate);
    }
  }
  if (conflicting.size > 1) {
    return {
      status: "needs-clarification",
      candidates: Object.freeze([...conflicting].sort()),
      rationale: "recogniser alternatives resolve to different commands",
    };
  }
  return primary;
}
