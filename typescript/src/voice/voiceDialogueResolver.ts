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

/**
 * Soft decline interjections. Alone they cancel; but a selection that FOLLOWS
 * them is a positive correction and may override ("nah, the winch up one").
 * A soft decline that trails the selection ("send it... nah") does not override.
 * Only the colloquial fillers qualify: a plain "no"/"nope" is an explicit
 * refusal ("no send it" must never resolve send-quote).
 */
const SOFT_DECLINE_TOKENS: ReadonlySet<string> = new Set(["nah", "naw"]);

/**
 * Explicit refusals. Unlike a soft interjection these state that the speaker
 * wants NOTHING done ("cancel send it", "neither, send it"), so a selection
 * alongside one is never resolved: it fails closed to `unresolved`. Without a
 * selection they cancel the clarification. "stop" is deliberately absent: it
 * is a catalog command word (`crawler.stop`) and must stay selectable.
 */
const EXPLICIT_REFUSAL_TOKENS: ReadonlySet<string> = new Set([
  "no",
  "nope",
  "cancel",
  "forget",
  "nevermind",
  "nowt",
  "none",
  "neither",
  "nothing",
  "abort",
  "belay",
  "disregard",
  "scrap",
  "scratch",
  "drop",
  "leave",
  "skip",
]);

/**
 * Exclusion markers. "anything but send it" / "the other one" point AWAY from
 * the named candidate, so a selection alongside one fails closed to
 * `unresolved`. On their own they neither select nor cancel.
 */
const EXCLUSION_TOKENS: ReadonlySet<string> = new Set([
  "but",
  "except",
  "excluding",
  "besides",
  "other",
  "instead",
  "than",
  "unless",
]);

/**
 * Hard scoping negation. Unlike the soft interjections in CANCEL_TOKENS
 * ("nah", "naw") — which a following selection may override ("nah, the winch up
 * one") — these NEGATE whatever request they accompany. "do not send it" must
 * never positively resolve `send-quote` just because the distinctive token
 * "send" is present. Their presence forces fail-closed: a negated selection
 * stays `unresolved`, and a negation with no selection `cancels`. Apostrophes
 * are stripped in `tokenize`, so "don't" arrives as "dont". ASR may also split
 * a contraction ("do n't", "don t", "do n t"); the stranded fragments `nt` and
 * `t` carry no other meaning in a reply, so they count as hard negation too.
 */
const HARD_NEGATION_TOKENS: ReadonlySet<string> = new Set([
  "not",
  "dont",
  "doesnt",
  "didnt",
  "wont",
  "cant",
  "cannot",
  "never",
  "isnt",
  "arent",
  "aint",
  "wouldnt",
  "couldnt",
  "shouldnt",
  "hadnt",
  "hasnt",
  "havent",
  "wasnt",
  "werent",
  "neednt",
  "mustnt",
  "without",
  "nt",
  "t",
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

/**
 * Normalise, strip apostrophes ("don't"→"dont", "what's"→"whats") and split on
 * any non-alphanumeric run — identical to the interpreter's tokeniser so that
 * negation contractions and tokens match consistently across both layers.
 */
function tokenize(raw: string): readonly string[] {
  const n = normalizeUtterance(raw).replace(/['’]/g, "");
  if (n === "") return [];
  return n.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
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
  // Only ever resolve within commands that exist in the active profile and were
  // actually offered. `live` is what an open clarification may still carry:
  // unknown, out-of-profile and duplicate ids are never echoed back.
  const live: VoiceCommand[] = [];
  for (const id of input.candidates) {
    const command = COMMAND_BY_ID.get(id);
    if (command === undefined || command.profile !== input.profile) continue;
    if (!live.includes(command)) live.push(command);
  }
  const liveIds: readonly string[] = live.map((c) => c.id);
  const open = (rationale: string): ClarificationResolution => ({
    status: "unresolved",
    candidates: liveIds,
    rationale,
  });

  // Defence in depth: never resolve an interim reply.
  if (input.isFinal === false) return open("reply not final");

  if (live.length === 0) return open("no live candidates to resolve");

  // An offered set containing an unknown, out-of-profile or duplicate id is not
  // the set the speaker heard: filtering it would shift ordinal positions
  // ("first" would land on what was offered second). Fail closed rather than
  // resolve against a set that differs from the one offered.
  if (live.length !== input.candidates.length) {
    return open("offered set contained unknown, out-of-profile or duplicate candidates");
  }
  const candidates = live;

  const tokens = tokenize(input.reply);
  if (tokens.length === 0) return open("empty reply");

  // 1. Positive selection by distinctive content token (e.g. "winch", "off")
  // 2. ...or by ordinal ("the first one", "the last").
  const distinctive = distinctiveTokens(candidates);
  const selected = new Set<string>();
  let firstSelectionIndex = -1;
  tokens.forEach((token, i) => {
    let id = distinctive.get(token);
    if (id === undefined) {
      if (LAST_WORDS.has(token)) {
        id = candidates[candidates.length - 1]!.id;
      } else {
        const index = ORDINALS.get(token);
        if (index !== undefined && index < candidates.length) id = candidates[index]!.id;
      }
    }
    if (id !== undefined) {
      selected.add(id);
      if (firstSelectionIndex === -1) firstSelectionIndex = i;
    }
  });

  // Hard scoping negation ("do not send it", "don't", "never") negates whatever
  // it accompanies. It must be checked BEFORE any positive selection, so a
  // distinctive token inside a refusal ("send" in "do not send it") can never
  // be resolved. A negated selection fails closed to `unresolved` (we cannot
  // tell what the speaker DOES want); a negation with no selection `cancels`.
  if (tokens.some((t) => HARD_NEGATION_TOKENS.has(t))) {
    if (selected.size >= 1) {
      return open("a negation scopes the named candidate; cannot infer the intended one");
    }
    return { status: "cancelled", rationale: "explicit negation with no selection" };
  }

  // Explicit refusal ("cancel send it", "neither, send it") or exclusion
  // ("anything but send it") alongside a selection: the named candidate is
  // being refused or pointed away from, never chosen. Fail closed.
  const refused = tokens.some((t) => EXPLICIT_REFUSAL_TOKENS.has(t));
  const excluded = tokens.some((t) => EXCLUSION_TOKENS.has(t));
  if (selected.size >= 1 && (refused || excluded)) {
    return open("a refusal or exclusion accompanies the named candidate");
  }

  // A soft interjection is overridden only by a selection that FOLLOWS it
  // ("nah, the winch one"). One at or after the selection ("send it... no")
  // retracts it, so the clarification stays open.
  const lastSoftDecline = tokens.reduce(
    (last, t, i) => (SOFT_DECLINE_TOKENS.has(t) ? i : last),
    -1,
  );
  const softDeclined = lastSoftDecline !== -1;
  if (selected.size >= 1 && lastSoftDecline > firstSelectionIndex) {
    return open("a decline follows the named candidate");
  }

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
  if (selected.size > 1) return open("reply named more than one candidate");

  // 3. No selection. A single-candidate clarification can be closed by a bare
  // affirmation ("yeah", "that's it"); a multi-candidate one cannot.
  const affirmed = tokens.some((t) => AFFIRM_TOKENS.has(t));
  const declined = refused || softDeclined;

  if (declined && !affirmed) {
    return { status: "cancelled", rationale: "reply declined every candidate" };
  }
  if (candidates.length === 1 && affirmed && !declined && !excluded) {
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
  return open("reply did not select a single candidate");
}
