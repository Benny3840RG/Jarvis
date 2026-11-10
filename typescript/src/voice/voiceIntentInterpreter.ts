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

/** Normalise then strip apostrophes so "what's"→"whats", "don't"→"dont". */
function tokenize(raw: string): { tokens: readonly string[]; joined: string } {
  const normalized = normalizeUtterance(raw).replace(/['’]/g, "");
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return { tokens, joined: tokens.join(" ") };
}

function groupMatches(group: Group, tokens: ReadonlySet<string>, joined: string): boolean {
  return group.some((alt) => (alt.includes(" ") ? joined.includes(alt) : tokens.has(alt)));
}

type Candidate = Readonly<{ commandId: string; score: number }>;

function bestCandidate(profile: VoiceProfile, tokens: readonly string[]): Candidate[] {
  const tokenSet = new Set(tokens);
  const joined = tokens.join(" ");
  const byCommand = new Map<string, number>();
  for (const signal of SIGNALS) {
    if (signal.profile !== profile) continue;
    let best = 0;
    for (const pattern of signal.patterns) {
      if (pattern.every((group) => groupMatches(group, tokenSet, joined))) {
        best = Math.max(best, pattern.length);
      }
    }
    if (best > 0) byCommand.set(signal.commandId, best);
  }
  return [...byCommand.entries()]
    .map(([commandId, score]) => ({ commandId, score }))
    .sort((a, b) => b.score - a.score);
}

function hasNegation(tokens: readonly string[]): boolean {
  return tokens.some((t) => NEGATION_TOKENS.has(t));
}

function isGuarded(command: VoiceCommand): boolean {
  return command.kind === "actuate" || command.criticality === "critical";
}

function proposalFor(tokens: readonly string[], profile: VoiceProfile): InterpretedIntent {
  const ranked = bestCandidate(profile, tokens);
  if (ranked.length === 0) {
    return { status: "no-intent", rationale: "no catalog signal matched in the active profile" };
  }

  if (hasNegation(tokens)) {
    return { status: "no-intent", rationale: "explicit negation; no proposal" };
  }

  const top = ranked[0]!;
  const compound = tokens.includes("and") || tokens.includes("or");
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
  const confidence = Math.min(
    1,
    0.55 + 0.15 * top.score + (top.score - (ranked[1]?.score ?? 0)) * 0.1,
  );
  return {
    status: "proposed",
    commandId: top.commandId,
    confidence: Number(confidence.toFixed(2)),
    requiresConfirmation: isGuarded(command),
    rationale: `matched ${top.score} intent group(s) for ${top.commandId}`,
  };
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

  const primary = proposalFor(tokenize(input.transcript).tokens, input.profile);

  const alternatives = input.alternatives ?? [];
  if (alternatives.length === 0 || primary.status !== "proposed") {
    return primary;
  }

  // An alternative that resolves to a different command casts doubt: fail closed.
  const conflicting = new Set<string>([primary.commandId]);
  for (const alternative of alternatives) {
    const alt = proposalFor(tokenize(alternative).tokens, input.profile);
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
