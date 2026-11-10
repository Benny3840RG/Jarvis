/**
 * Jarvis voice — clarification resolver (Wave Two, #567).
 *
 * WHAT THIS IS. The second increment of natural contextual understanding. When
 * {@link interpretIntent} returns `needs-clarification` with a candidate set,
 * this layer resolves the speaker's *follow-up* reply against exactly that set:
 * "the first one", "the winch one", "nah forget it". It turns a one-shot
 * interpreter into a two-turn dialogue without ever widening what may happen.
 *
 * WHAT THIS IS NOT — the safety contract that makes it safe to add:
 *   - It NEVER dispatches, approves, actuates or executes, and it is NOT wired
 *     into `voiceParser.ts`, `voiceSession.ts` or any live path. It returns a
 *     resolution and nothing else. A resolved command is advisory context a
 *     caller may surface or route through the existing spoken-confirmation
 *     boundary; it is never an effect.
 *   - It resolves ONLY within the offered candidate set. There is no code path
 *     by which it can name a command the interpreter did not already propose,
 *     so a follow-up can never broaden intent beyond the prior turn.
 *   - It FAILS CLOSED. A reply that picks nothing, picks two things at once, or
 *     is not final leaves the clarification OPEN (`unresolved`) — never a guess.
 *     A reply that declines without selecting `cancels`. It never upgrades
 *     authority: a resolved guarded command still `requiresConfirmation`.
 *
 * Deterministic and dependency-free (except the catalog), so it is pure and
 * fully testable, mirroring the interpreter. The `ClarificationResolution`
 * shape is the stable contract; a model-backed resolver could sit behind it
 * unchanged.
 */

import {
  VOICE_COMMANDS,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";

export type ResolveInput = Readonly<{
  /** The speaker's follow-up reply to the clarification question. */
  reply: string;
  /** The candidate command ids offered by the prior `needs-clarification`. */
  candidates: readonly string[];
  profile: VoiceProfile;
  /**
   * Whether the reply is final. Defaults to true. When explicitly false the
   * resolver withholds — defence in depth, matching the interpreter.
   */
  isFinal?: boolean;
}>;

export type ClarificationResolution =
  /** The reply selected exactly one candidate. Advisory only. */
  | Readonly<{
      status: "resolved";
      commandId: string;
      confidence: number;
      /** A guarded command still needs confirmation + exact dispatch downstream. */
      requiresConfirmation: boolean;
      rationale: string;
    }>
  /** The speaker declined every candidate; the clarification should be dropped. */
  | Readonly<{ status: "cancelled"; rationale: string }>
  /** Still no single choice; the clarification stays open with these candidates. */
  | Readonly<{ status: "unresolved"; candidates: readonly string[]; rationale: string }>;

const COMMAND_BY_ID: ReadonlyMap<string, VoiceCommand> = new Map(
  VOICE_COMMANDS.map((c) => [c.id, c]),
);

/** Explicit decline markers. Present without a selection ⇒ cancel the clarification. */
const CANCEL_TOKENS: ReadonlySet<string> = new Set([
  "cancel",
  "forget",
  "nevermind",
  "nowt",
  "none",
  "neither",
  "nothing",
  "no",
  "nope",
  "nah",
  "naw",
  "abort",
  "belay",
  "disregard",
  "scrap",
  "scratch",
  "drop",
  "leave",
]);

/** Affirmation markers. Meaningful only for a single-candidate clarification. */
const AFFIRM_TOKENS: ReadonlySet<string> = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "correct",
  "right",
  "confirm",
  "confirmed",
  "affirmative",
  "ok",
  "okay",
  "roger",
]);

/**
 * Ordinal words → zero-based index. Only small, unambiguous ordinals; anything
 * larger falls through to no-selection rather than an uncertain guess. `last`
 * and `final` are resolved against the candidate count separately.
 */
const ORDINALS: ReadonlyMap<string, number> = new Map([
  ["first", 0],
  ["1st", 0],
  ["second", 1],
  ["2nd", 1],
  ["third", 2],
  ["3rd", 2],
  ["fourth", 3],
  ["4th", 3],
]);
const LAST_WORDS: ReadonlySet<string> = new Set(["last", "final", "latter"]);

/**
 * Filler/stopwords excluded from distinctive-token matching so that a word
 * shared by English filler (not by intent) can never select a candidate.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "to",
  "and",
  "or",
  "of",
  "please",
  "jarvis",
  "command",
  "that",
  "this",
  "it",
  "one",
  "ones",
  "thing",
  "do",
  "go",
  "just",
  "my",
  "me",
  "i",
  "we",
  "you",
  "them",
  "then",
]);

function tokenize(raw: string): readonly string[] {
  const n = normalizeUtterance(raw);
  if (n === "") return [];
  return n.split(" ").filter((t) => t.length > 0);
}

function isGuarded(command: VoiceCommand): boolean {
  return command.kind === "actuate" || command.criticality === "critical";
}

/**
 * The content tokens that identify a command: every token of its canonical
 * phrases plus its id tail (`crawler.lights-on` → `lights`, `on`), minus
 * stopwords. These are the words a speaker could use to point at it.
 */
function contentTokens(command: VoiceCommand): ReadonlySet<string> {
  const out = new Set<string>();
  for (const phrase of command.phrases) {
    for (const token of phrase.split(" ")) {
      if (token.length > 0 && !STOPWORDS.has(token)) out.add(token);
    }
  }
  const tail = command.id.split(".").slice(1).join(".");
  for (const token of tail.split(/[-.]/)) {
    if (token.length > 0 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/**
 * Tokens unique to ONE candidate within the offered set. A reply token that is
 * a distinctive token selects that candidate; a token shared by several
 * candidates distinguishes none, so it is dropped from the distinctive pool.
 */
function distinctiveTokens(candidates: readonly VoiceCommand[]): ReadonlyMap<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const command of candidates) {
    for (const token of contentTokens(command)) {
      (owners.get(token) ?? owners.set(token, new Set()).get(token)!).add(command.id);
    }
  }
  const distinctive = new Map<string, string>();
  for (const [token, ids] of owners) {
    if (ids.size === 1) distinctive.set(token, [...ids][0]!);
  }
  return distinctive;
}

/**
 * Resolve a follow-up reply against the candidate set a prior
 * `needs-clarification` offered. Pure and fail-closed.
 */
export function resolveClarification(input: ResolveInput): ClarificationResolution {
  const offered = input.candidates;

  // Defence in depth: never resolve an interim reply.
  if (input.isFinal === false) {
    return { status: "unresolved", candidates: offered, rationale: "reply not final" };
  }

  // Only ever resolve within commands that exist in the active profile and were
  // actually offered. Anything else is dropped before matching, so resolution
  // is structurally confined to the prior proposal.
  const candidates = offered
    .map((id) => COMMAND_BY_ID.get(id))
    .filter((c): c is VoiceCommand => c !== undefined && c.profile === input.profile);

  if (candidates.length === 0) {
    return {
      status: "unresolved",
      candidates: offered,
      rationale: "no live candidates to resolve",
    };
  }

  const tokens = tokenize(input.reply);
  if (tokens.length === 0) {
    return { status: "unresolved", candidates: offered, rationale: "empty reply" };
  }

  // 1. Positive selection by distinctive content token (e.g. "winch", "off").
  const distinctive = distinctiveTokens(candidates);
  const selectedByToken = new Set<string>();
  for (const token of tokens) {
    const owner = distinctive.get(token);
    if (owner !== undefined) selectedByToken.add(owner);
  }

  // 2. Positive selection by ordinal ("the first one", "the last").
  const selectedByOrdinal = new Set<string>();
  for (const token of tokens) {
    if (LAST_WORDS.has(token)) {
      selectedByOrdinal.add(candidates[candidates.length - 1]!.id);
      continue;
    }
    const index = ORDINALS.get(token);
    if (index !== undefined && index >= 0 && index < candidates.length) {
      selectedByOrdinal.add(candidates[index]!.id);
    }
  }

  const selected = new Set<string>([...selectedByToken, ...selectedByOrdinal]);

  // An explicit, single, unambiguous selection wins — even alongside a filler
  // "nah"/"no", because "nah, the winch one" still names the winch.
  if (selected.size === 1) {
    const command = COMMAND_BY_ID.get([...selected][0]!)!;
    return {
      status: "resolved",
      commandId: command.id,
      confidence: 0.9,
      requiresConfirmation: isGuarded(command),
      rationale: "reply named one offered candidate",
    };
  }
  if (selected.size > 1) {
    return {
      status: "unresolved",
      candidates: offered,
      rationale: "reply named more than one candidate",
    };
  }

  // 3. No selection. A single-candidate clarification can be closed by a bare
  // affirmation ("yeah", "that's it"); a multi-candidate one cannot.
  const affirmed = tokens.some((t) => AFFIRM_TOKENS.has(t));
  const declined = tokens.some((t) => CANCEL_TOKENS.has(t));

  if (declined && !affirmed) {
    return { status: "cancelled", rationale: "reply declined every candidate" };
  }
  if (candidates.length === 1 && affirmed && !declined) {
    const command = candidates[0]!;
    return {
      status: "resolved",
      commandId: command.id,
      confidence: 0.8,
      requiresConfirmation: isGuarded(command),
      rationale: "affirmation of the sole offered candidate",
    };
  }

  // Everything else — a bare "yes" to several options, an unrelated utterance,
  // a conflicting "yes but no" — leaves the clarification open.
  return {
    status: "unresolved",
    candidates: offered,
    rationale: "reply did not select a single candidate",
  };
}
