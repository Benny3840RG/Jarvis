/**
 * Jarvis guarded voice interface — session state and dispatch (#567).
 *
 * A `VoiceSession` is the stateful orchestrator that turns a recognised
 * utterance into a safe decision. One instance per operator session; instances
 * share no mutable state (session isolation, tested). It owns:
 *
 *   - a bounded history ring buffer (no unbounded growth);
 *   - a single-use, TTL-bound pending confirmation for critical commands
 *     (replay-protected: consuming it clears it);
 *   - confirmation invalidation on a fresh command, reset, profile change and manual override;
 *   - the hardware boundary: actuation goes through the provider and fails
 *     closed when hardware is unavailable.
 *
 * The session NEVER approves or executes a governed action. A `propose`
 * command yields a `proposed` decision carrying the command's governed
 * tool/operation descriptor; staging it on the real `ToolActionService` and the
 * owner approval path is the HTTP slice's job. Spoken confirmation guards
 * against accidental activation; it is not an authorisation boundary and never
 * carries an approval token.
 */

import {
  VOICE_COMMANDS,
  VOICE_CONTROL_PHRASES,
  findVoiceCommand,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";
import type { VoiceActuationProvider } from "./voiceHardware.js";
import { resolveClarification } from "./voiceDialogueResolver.js";
import { classifyVoiceDictation, voiceDictationKey } from "./voiceDictation.js";
import { interpretIntent } from "./voiceIntentInterpreter.js";
import { parseUtterance } from "./voiceParser.js";
import type { VoiceQueryProvider } from "./voiceQuery.js";
import type { VoiceWriteCapture } from "./voiceSafeWrite.js";

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_CONFIRMATION_TTL_MS = 30_000;

/** Resolve a catalog command by id, for mapping an interpreter proposal. */
const COMMAND_BY_ID: ReadonlyMap<string, VoiceCommand> = new Map(
  VOICE_COMMANDS.map((command) => [command.id, command]),
);

const CHOICE_WORDS = new Set([
  "the",
  "a",
  "an",
  "it",
  "one",
  "ones",
  "this",
  "that",
  "please",
  "jarvis",
  "first",
  "second",
  "third",
  "fourth",
  "last",
  "final",
  "latter",
  "1st",
  "2nd",
  "3rd",
  "4th",
  "yes",
  "yeah",
  "yep",
  "yup",
  "correct",
  "right",
  "ok",
  "okay",
  "roger",
  "affirmative",
  "nah",
  "naw",
]);

/** A no-catalog-signal reply can select only by pointing at the offered command. */
function isBareClarificationChoice(transcript: string, command: VoiceCommand): boolean {
  const words = new Set(CHOICE_WORDS);
  for (const phrase of command.phrases) {
    for (const word of phrase.split(" ")) words.add(word);
  }
  for (const word of command.id.split(/[.-]/)) words.add(word);
  return normalizeUtterance(transcript)
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((word) => words.has(word));
}

const CONFIRM_PHRASES = new Set(VOICE_CONTROL_PHRASES.confirm.map(normalizeUtterance));
const CANCEL_PHRASES = new Set(VOICE_CONTROL_PHRASES.cancel.map(normalizeUtterance));

type VoiceControlIntent = "confirm" | "cancel";

function controlIntent(normalized: string): VoiceControlIntent | undefined {
  if (CONFIRM_PHRASES.has(normalized)) return "confirm";
  if (CANCEL_PHRASES.has(normalized)) return "cancel";
  return undefined;
}

function controlCandidates(
  profile: VoiceProfile,
  topIntent: VoiceControlIntent,
  alternatives: readonly string[] | undefined,
): string[] {
  const candidates = new Set<string>([`control.${topIntent}`]);
  for (const alternative of alternatives ?? []) {
    const normalized = normalizeUtterance(alternative);
    const intent = controlIntent(normalized);
    if (intent) {
      candidates.add(`control.${intent}`);
      continue;
    }
    const command = findVoiceCommand(profile, normalized);
    if (command) candidates.add(command.id);
  }
  return [...candidates].sort();
}

function controlAlternativeCandidates(
  alternatives: readonly string[] | undefined,
): readonly string[] {
  const candidates = new Set<string>();
  for (const alternative of alternatives ?? []) {
    const intent = controlIntent(normalizeUtterance(alternative));
    if (intent) candidates.add(`control.${intent}`);
  }
  return Object.freeze([...candidates].sort());
}

/**
 * Candidates raised by alternative hypotheses that dictate (or try to dictate) a
 * safe write. A rejected/unsafe dictation counts: it is a competing hypothesis
 * the session must not silently drop.
 */
function dictationAlternativeCandidates(
  profile: VoiceProfile,
  alternatives: readonly string[] | undefined,
  topKey?: string,
): readonly string[] {
  const candidates = new Set<string>();
  for (const alternative of alternatives ?? []) {
    const result = classifyVoiceDictation(alternative, profile);
    if (result.status === "rejected") candidates.add("dictation.rejected");
    else if (result.status === "captured") {
      if (topKey === undefined || voiceDictationKey(result.dictation) !== topKey) {
        candidates.add(result.dictation.command.id);
      }
    }
  }
  return Object.freeze([...candidates].sort());
}

export type VoiceHistoryEntry = Readonly<{
  at: number;
  normalizedTranscript: string;
  outcome: string;
  commandId?: string;
}>;

export type PendingConfirmation = Readonly<{
  command: VoiceCommand;
  issuedAt: number;
  expiresAt: number;
  /**
   * Spoken capture (title, task category) parsed by the dictation grammar. It is
   * read back to the owner and only travels with this single-use confirmation.
   */
  capture?: VoiceWriteCapture;
}>;

type PendingClarification = Readonly<{
  candidates: readonly string[];
  profile: VoiceProfile;
  expiresAt: number;
}>;

export type VoiceDispatch =
  | Readonly<{ decision: "ignored-interim" }>
  | Readonly<{ decision: "empty" }>
  | Readonly<{ decision: "unrecognized"; normalizedTranscript: string }>
  | Readonly<{ decision: "ambiguous"; candidates: readonly string[] }>
  | Readonly<{ decision: "answered"; command: VoiceCommand; answer: string }>
  | Readonly<{ decision: "query-unavailable"; command: VoiceCommand; reason: string }>
  | Readonly<{
      decision: "awaiting-confirmation";
      command: VoiceCommand;
      expiresAt: number;
      /**
       * True when the command was inferred from natural language by the intent
       * interpreter rather than matched exactly. An inferred command is NEVER
       * dispatched directly: it always waits here for an explicit spoken
       * confirmation, so natural-language confidence can never actuate on its own.
       */
      inferred?: true;
      /** Interpreter confidence (0..1) for an inferred command. */
      confidence?: number;
      /** Dictated safe-write fields awaiting the spoken read-back confirmation. */
      capture?: VoiceWriteCapture;
    }>
  | Readonly<{ decision: "confirmation-not-pending" }>
  | Readonly<{ decision: "confirmation-expired"; command: VoiceCommand }>
  | Readonly<{ decision: "cancelled"; command: VoiceCommand }>
  | Readonly<{ decision: "proposed"; command: VoiceCommand; capture?: VoiceWriteCapture }>
  | Readonly<{
      decision: "actuation-unavailable";
      command: VoiceCommand;
      target: string;
      reason: string;
    }>
  | Readonly<{ decision: "actuated"; command: VoiceCommand; target: string }>
  | Readonly<{
      decision: "actuation-failed";
      command: VoiceCommand;
      target: string;
      reason: string;
    }>;

export type VoiceSessionOptions = Readonly<{
  profile: VoiceProfile;
  provider: VoiceActuationProvider;
  /** Read-only answers. Absent means every query stays explicitly unavailable. */
  queries?: VoiceQueryProvider;
  historyLimit?: number;
  confirmationTtlMs?: number;
  clock?: () => number;
  /**
   * When true, a final transcript the exact parser does not recognise is passed
   * to the natural-language intent interpreter. A confident proposal is routed
   * INTO the confirmation path (it arms a single-use pending confirmation and
   * returns `awaiting-confirmation`), never dispatched directly. Interpretation
   * only runs for a wake-authorised call (see `VoiceSessionInput.wakeAuthorized`),
   * so it cannot smuggle an intent out of unaddressed or wake-failed speech.
   * Defaults to false: with it off the session behaves exactly as before.
   */
  interpretNaturalLanguage?: boolean;
}>;

export type VoiceSessionInput = Readonly<{
  transcript: string;
  isFinal: boolean;
  alternatives?: readonly string[];
  /**
   * Whether this utterance passed the wake-word gate. Natural-language
   * interpretation runs only when this is true, so wake-failed speech (e.g.
   * "jarvisx add a task") can never be interpreted into a command. The exact
   * parser path is unaffected by this field.
   */
  wakeAuthorized?: boolean;
  /** Deterministic clock override for a single call (tests). */
  now?: number;
}>;

export class VoiceSession {
  #profile: VoiceProfile;
  readonly #provider: VoiceActuationProvider;
  readonly #queries: VoiceQueryProvider | undefined;
  readonly #historyLimit: number;
  readonly #confirmationTtlMs: number;
  readonly #clock: () => number;
  readonly #interpret: boolean;
  readonly #history: VoiceHistoryEntry[] = [];
  #pending: PendingConfirmation | undefined;
  #clarification: PendingClarification | undefined;

  constructor(options: VoiceSessionOptions) {
    this.#profile = options.profile;
    this.#provider = options.provider;
    this.#queries = options.queries;
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#clock = options.clock ?? Date.now;
    this.#interpret = options.interpretNaturalLanguage ?? false;
  }

  get profile(): VoiceProfile {
    return this.#profile;
  }

  pending(): PendingConfirmation | undefined {
    return this.#pending;
  }

  history(): readonly VoiceHistoryEntry[] {
    return [...this.#history];
  }

  /** Switch profile. Invalidates any pending confirmation (R-049-style reset). */
  setProfile(profile: VoiceProfile, now?: number): void {
    this.#profile = profile;
    this.#invalidatePending();
    void now;
  }

  /** Clear all session state. */
  reset(now?: number): void {
    this.#history.length = 0;
    this.#invalidatePending();
    void now;
  }

  /** Operator took manual control; any armed confirmation is void. */
  manualOverride(now?: number): void {
    this.#invalidatePending();
    void now;
  }

  async handle(input: VoiceSessionInput): Promise<VoiceDispatch> {
    const now = input.now ?? this.#clock();
    const normalized = normalizeUtterance(input.transcript);

    if (!input.isFinal) {
      this.#record(now, normalized, "ignored-interim");
      return { decision: "ignored-interim" };
    }

    const intent = controlIntent(normalized);
    if (intent) {
      const candidates = controlCandidates(this.#profile, intent, input.alternatives);
      // A confirm must be unanimous: any alternative that dictates a write (even
      // the pending one) is a conflicting intent and voids the pending capture.
      if (intent === "confirm") {
        for (const id of dictationAlternativeCandidates(this.#profile, input.alternatives)) {
          if (!candidates.includes(id)) candidates.push(id);
        }
        candidates.sort();
      }
      if (candidates.length > 1) {
        this.#record(now, normalized, "ambiguous");
        this.#invalidatePending();
        return { decision: "ambiguous", candidates };
      }
    } else {
      const topCommand = findVoiceCommand(this.#profile, normalized);
      const controlAlternatives = [
        ...controlAlternativeCandidates(input.alternatives),
        ...dictationAlternativeCandidates(this.#profile, input.alternatives),
      ];
      if (topCommand && controlAlternatives.length > 0) {
        const candidates = Object.freeze([topCommand.id, ...controlAlternatives].sort());
        this.#record(now, normalized, "ambiguous");
        this.#invalidatePending();
        return { decision: "ambiguous", candidates };
      }
    }

    if (intent === "confirm") {
      this.#clarification = undefined;
      return this.#handleConfirm(now, normalized);
    }
    if (intent === "cancel") {
      this.#clarification = undefined;
      return this.#handleCancel(now, normalized);
    }

    const outcome = parseUtterance({
      transcript: input.transcript,
      isFinal: true,
      profile: this.#profile,
      alternatives: input.alternatives,
    });

    switch (outcome.status) {
      case "empty":
        this.#clarification = undefined;
        this.#record(now, normalized, "empty");
        return { decision: "empty" };
      case "no-match":
        return this.#handleNoMatch(now, outcome.normalizedTranscript, input);
      case "ambiguous":
        this.#clarification = undefined;
        this.#record(now, outcome.normalizedTranscript, "ambiguous");
        return { decision: "ambiguous", candidates: outcome.candidates };
      case "recognized":
        return this.#handleRecognized(now, outcome.normalizedTranscript, outcome.command);
      /* c8 ignore next 2 -- a final transcript never yields pending-final */
      default:
        return { decision: "empty" };
    }
  }

  /**
   * The exact parser found no whole-utterance match. When natural-language
   * interpretation is enabled AND the call is wake-authorised, consult the
   * interpreter. A confident proposal is routed into the confirmation path (it
   * arms a single-use pending and returns `awaiting-confirmation`), never
   * dispatched directly; a tie asks for clarification. Otherwise the utterance
   * stays `unrecognized`, exactly as before.
   */
  #handleNoMatch(
    now: number,
    normalizedTranscript: string,
    input: VoiceSessionInput,
  ): VoiceDispatch {
    const clarification = this.#clarification;
    if (clarification && now < clarification.expiresAt) {
      // A clarification gets exactly one final follow-up. Consume it before
      // resolving so an unrelated or unsafe reply cannot leave an old choice.
      this.#clarification = undefined;
      if (clarification.profile === this.#profile && input.wakeAuthorized === true) {
        const controls = controlAlternativeCandidates(input.alternatives);
        if (controls.length > 0) {
          this.#record(now, normalizedTranscript, "ambiguous");
          return { decision: "ambiguous", candidates: controls };
        }
        const resolution = resolveClarification({
          reply: input.transcript,
          candidates: clarification.candidates,
          profile: this.#profile,
          isFinal: true,
        });
        if (resolution.status === "cancelled") {
          this.#record(now, normalizedTranscript, "cancel");
          return { decision: "confirmation-not-pending" };
        }
        if (resolution.status === "resolved") {
          // The resolver only compares offered choices. The guarded interpreter
          // must also agree that the reply is a request for this same command,
          // or find no catalog signal (as with a bare ordinal/"send it").
          const selected = COMMAND_BY_ID.get(resolution.commandId);
          const replyAgrees = (transcript: string): boolean => {
            const intent = interpretIntent({ transcript, profile: this.#profile, isFinal: true });
            return (
              (intent.status === "proposed" && intent.commandId === resolution.commandId) ||
              (intent.status === "no-intent" &&
                intent.rationale === "no catalog signal matched in the active profile" &&
                selected !== undefined &&
                isBareClarificationChoice(transcript, selected))
            );
          };
          if (!replyAgrees(input.transcript) || !(input.alternatives ?? []).every(replyAgrees)) {
            this.#record(now, normalizedTranscript, "unrecognized");
            return { decision: "unrecognized", normalizedTranscript };
          }
          const alternativesAgree = (input.alternatives ?? []).every((alternative) => {
            const other = resolveClarification({
              reply: alternative,
              candidates: clarification.candidates,
              profile: this.#profile,
              isFinal: true,
            });
            return other.status === "resolved" && other.commandId === resolution.commandId;
          });
          if (!alternativesAgree) {
            this.#record(now, normalizedTranscript, "ambiguous");
            return { decision: "ambiguous", candidates: clarification.candidates };
          }
          const command = COMMAND_BY_ID.get(resolution.commandId);
          if (
            command &&
            clarification.candidates.includes(command.id) &&
            command.profile === this.#profile
          ) {
            const expiresAt = now + this.#confirmationTtlMs;
            this.#pending = { command, issuedAt: now, expiresAt };
            this.#record(now, normalizedTranscript, "clarified", command.id);
            return {
              decision: "awaiting-confirmation",
              command,
              expiresAt,
              inferred: true,
              confidence: resolution.confidence,
            };
          }
        }
        this.#record(now, normalizedTranscript, "unrecognized");
        return { decision: "unrecognized", normalizedTranscript };
      }
      this.#record(now, normalizedTranscript, "unrecognized");
      return { decision: "unrecognized", normalizedTranscript };
    }
    // An expired offer has no authority over this turn. Clear it, then parse
    // the current request through the ordinary guarded interpreter below.
    if (clarification) this.#clarification = undefined;
    if (input.wakeAuthorized === true) {
      const dictated = this.#handleDictation(now, normalizedTranscript, input);
      if (dictated) return dictated;
    }
    if (this.#interpret && input.wakeAuthorized === true) {
      const intent = interpretIntent({
        transcript: input.transcript,
        profile: this.#profile,
        isFinal: true,
        ...(input.alternatives ? { alternatives: input.alternatives } : {}),
      });
      if (intent.status === "proposed") {
        const command = COMMAND_BY_ID.get(intent.commandId);
        if (command) {
          // A control hypothesis cannot be ignored just because the top
          // hypothesis needed inference instead of an exact catalog match.
          const controlAlternatives = controlAlternativeCandidates(input.alternatives);
          if (controlAlternatives.length > 0) {
            const candidates = Object.freeze([command.id, ...controlAlternatives].sort());
            this.#invalidatePending();
            this.#record(now, normalizedTranscript, "ambiguous");
            return { decision: "ambiguous", candidates };
          }
          // Inferred intent always waits for an explicit confirmation — it is
          // never dispatched here, whatever the command's own criticality.
          this.#invalidatePending();
          this.#record(now, normalizedTranscript, "interpreted", command.id);
          const expiresAt = now + this.#confirmationTtlMs;
          this.#pending = { command, issuedAt: now, expiresAt };
          return {
            decision: "awaiting-confirmation",
            command,
            expiresAt,
            inferred: true,
            confidence: intent.confidence,
          };
        }
      } else if (intent.status === "needs-clarification") {
        this.#invalidatePending();
        const candidates = intent.candidates;
        if (
          candidates.length > 0 &&
          candidates.length <= VOICE_COMMANDS.length &&
          new Set(candidates).size === candidates.length &&
          candidates.every((id) => COMMAND_BY_ID.get(id)?.profile === this.#profile) &&
          controlAlternativeCandidates(input.alternatives).length === 0
        ) {
          this.#clarification = {
            candidates: Object.freeze([...candidates]),
            profile: this.#profile,
            expiresAt: now + this.#confirmationTtlMs,
          };
        }
        this.#record(now, normalizedTranscript, "ambiguous");
        return { decision: "ambiguous", candidates: intent.candidates };
      }
    }
    this.#record(now, normalizedTranscript, "unrecognized");
    return { decision: "unrecognized", normalizedTranscript };
  }

  /**
   * Spoken capture for a safe write ("add a task: order bar oil"). Only runs on
   * wake-authorised final speech. A dictation never dispatches: it always arms
   * the single-use confirmation so the owner hears the captured text first.
   * Any recogniser alternative that is a control phrase or dictates a different
   * command makes the turn ambiguous instead (fail closed).
   */
  #handleDictation(
    now: number,
    normalizedTranscript: string,
    input: VoiceSessionInput,
  ): VoiceDispatch | undefined {
    const top = classifyVoiceDictation(input.transcript, this.#profile);
    if (top.status === "none") return undefined;
    if (top.status === "rejected") {
      // Unsafe or malformed dictation: fail closed here. It must not arm a
      // pending confirmation and must not fall through to inference.
      this.#invalidatePending();
      this.#record(now, normalizedTranscript, "dictation-rejected");
      return { decision: "unrecognized", normalizedTranscript };
    }
    const dictation = top.dictation;
    const topKey = voiceDictationKey(dictation);
    const conflicting = new Set<string>([
      ...controlAlternativeCandidates(input.alternatives),
      ...dictationAlternativeCandidates(this.#profile, input.alternatives, topKey),
    ]);
    for (const alternative of input.alternatives ?? []) {
      const normalizedAlternative = normalizeUtterance(alternative);
      if (classifyVoiceDictation(alternative, this.#profile).status !== "none") continue;
      const other = findVoiceCommand(this.#profile, normalizedAlternative);
      if (other) conflicting.add(other.id);
    }
    if (conflicting.size > 0) {
      const candidates = Object.freeze([...new Set([dictation.command.id, ...conflicting])].sort());
      this.#invalidatePending();
      this.#record(now, normalizedTranscript, "ambiguous");
      return { decision: "ambiguous", candidates };
    }
    this.#invalidatePending();
    this.#record(now, normalizedTranscript, "dictated", dictation.command.id);
    const expiresAt = now + this.#confirmationTtlMs;
    this.#pending = {
      command: dictation.command,
      issuedAt: now,
      expiresAt,
      capture: dictation.capture,
    };
    return {
      decision: "awaiting-confirmation",
      command: dictation.command,
      expiresAt,
      capture: dictation.capture,
    };
  }

  #handleRecognized(
    now: number,
    normalizedTranscript: string,
    command: VoiceCommand,
  ): VoiceDispatch | Promise<VoiceDispatch> {
    // A newly accepted command replaces the previous intent. In particular,
    // a routine stop must never leave an earlier start armed for a later confirm.
    this.#invalidatePending();
    this.#record(now, normalizedTranscript, "recognized", command.id);
    if (command.requiresSpokenConfirmation) {
      const expiresAt = now + this.#confirmationTtlMs;
      this.#pending = { command, issuedAt: now, expiresAt };
      return { decision: "awaiting-confirmation", command, expiresAt };
    }
    return this.#dispatch(command, now);
  }

  #handleConfirm(now: number, normalized: string): VoiceDispatch | Promise<VoiceDispatch> {
    this.#record(now, normalized, "confirm");
    const pending = this.#pending;
    if (!pending) return { decision: "confirmation-not-pending" };
    // Consume single-use so a replayed confirm cannot act twice.
    this.#pending = undefined;
    if (now >= pending.expiresAt) {
      return { decision: "confirmation-expired", command: pending.command };
    }
    if (pending.capture && pending.command.kind === "propose") {
      // A dictated capture is the exact text the owner just heard read back.
      return { decision: "proposed", command: pending.command, capture: pending.capture };
    }
    return this.#dispatch(pending.command, now);
  }

  #handleCancel(now: number, normalized: string): VoiceDispatch {
    this.#record(now, normalized, "cancel");
    const pending = this.#pending;
    if (!pending) return { decision: "confirmation-not-pending" };
    this.#pending = undefined;
    return { decision: "cancelled", command: pending.command };
  }

  async #dispatch(command: VoiceCommand, now: number): Promise<VoiceDispatch> {
    switch (command.kind) {
      case "query":
        return this.#query(command, now);
      case "propose":
        return { decision: "proposed", command };
      case "actuate":
        return this.#actuate(command);
    }
  }

  async #query(command: VoiceCommand, now: number): Promise<VoiceDispatch> {
    if (!this.#queries) {
      return {
        decision: "query-unavailable",
        command,
        reason: "No read-only query provider is connected for this voice command.",
      };
    }
    let result;
    try {
      result = await this.#queries.answer({ commandId: command.id, now });
    } catch {
      return {
        decision: "query-unavailable",
        command,
        reason: "The voice query provider failed before returning an authoritative answer.",
      };
    }
    if (result.status === "unavailable") {
      return { decision: "query-unavailable", command, reason: result.reason };
    }
    const answer = result.answer.trim();
    if (answer.length === 0) {
      return {
        decision: "query-unavailable",
        command,
        reason: "The voice query provider returned an empty answer.",
      };
    }
    return { decision: "answered", command, answer };
  }

  async #actuate(command: VoiceCommand): Promise<VoiceDispatch> {
    const target = command.actuationTarget;
    /* c8 ignore next 3 -- catalog invariant guarantees a target on actuate */
    if (!target) {
      return {
        decision: "actuation-failed",
        command,
        target: command.id,
        reason: "No actuation target bound.",
      };
    }
    if (this.#provider.statusOf(target) !== "available") {
      return {
        decision: "actuation-unavailable",
        command,
        target,
        reason: "Hardware is unavailable; the command failed closed.",
      };
    }
    const result = await this.#provider.actuate({ target, commandId: command.id });
    switch (result.status) {
      case "actuated":
        return { decision: "actuated", command, target };
      case "unavailable":
        return { decision: "actuation-unavailable", command, target, reason: result.reason };
      case "failed":
        return { decision: "actuation-failed", command, target, reason: result.reason };
    }
  }

  #invalidatePending(): void {
    this.#pending = undefined;
    this.#clarification = undefined;
  }

  #record(at: number, normalizedTranscript: string, outcome: string, commandId?: string): void {
    this.#history.push(
      commandId
        ? { at, normalizedTranscript, outcome, commandId }
        : { at, normalizedTranscript, outcome },
    );
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
  }
}
