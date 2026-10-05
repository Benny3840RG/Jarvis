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
  VOICE_CONTROL_PHRASES,
  findVoiceCommand,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";
import type { VoiceActuationProvider } from "./voiceHardware.js";
import { parseUtterance } from "./voiceParser.js";

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_CONFIRMATION_TTL_MS = 30_000;

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
): readonly string[] {
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
  return Object.freeze([...candidates].sort());
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
}>;

export type VoiceDispatch =
  | Readonly<{ decision: "ignored-interim" }>
  | Readonly<{ decision: "empty" }>
  | Readonly<{ decision: "unrecognized"; normalizedTranscript: string }>
  | Readonly<{ decision: "ambiguous"; candidates: readonly string[] }>
  | Readonly<{ decision: "query-unavailable"; command: VoiceCommand; reason: string }>
  | Readonly<{ decision: "awaiting-confirmation"; command: VoiceCommand; expiresAt: number }>
  | Readonly<{ decision: "confirmation-not-pending" }>
  | Readonly<{ decision: "confirmation-expired"; command: VoiceCommand }>
  | Readonly<{ decision: "cancelled"; command: VoiceCommand }>
  | Readonly<{ decision: "proposed"; command: VoiceCommand }>
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
  historyLimit?: number;
  confirmationTtlMs?: number;
  clock?: () => number;
}>;

export type VoiceSessionInput = Readonly<{
  transcript: string;
  isFinal: boolean;
  alternatives?: readonly string[];
  /** Deterministic clock override for a single call (tests). */
  now?: number;
}>;

export class VoiceSession {
  #profile: VoiceProfile;
  readonly #provider: VoiceActuationProvider;
  readonly #historyLimit: number;
  readonly #confirmationTtlMs: number;
  readonly #clock: () => number;
  readonly #history: VoiceHistoryEntry[] = [];
  #pending: PendingConfirmation | undefined;

  constructor(options: VoiceSessionOptions) {
    this.#profile = options.profile;
    this.#provider = options.provider;
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#clock = options.clock ?? Date.now;
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
      if (candidates.length > 1) {
        this.#record(now, normalized, "ambiguous");
        this.#invalidatePending();
        return { decision: "ambiguous", candidates };
      }
    } else {
      const topCommand = findVoiceCommand(this.#profile, normalized);
      const controlAlternatives = controlAlternativeCandidates(input.alternatives);
      if (topCommand && controlAlternatives.length > 0) {
        const candidates = Object.freeze([topCommand.id, ...controlAlternatives].sort());
        this.#record(now, normalized, "ambiguous");
        this.#invalidatePending();
        return { decision: "ambiguous", candidates };
      }
    }

    if (intent === "confirm") {
      return this.#handleConfirm(now, normalized);
    }
    if (intent === "cancel") {
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
        this.#record(now, normalized, "empty");
        return { decision: "empty" };
      case "no-match":
        this.#record(now, outcome.normalizedTranscript, "unrecognized");
        return { decision: "unrecognized", normalizedTranscript: outcome.normalizedTranscript };
      case "ambiguous":
        this.#record(now, outcome.normalizedTranscript, "ambiguous");
        return { decision: "ambiguous", candidates: outcome.candidates };
      case "recognized":
        return this.#handleRecognized(now, outcome.normalizedTranscript, outcome.command);
      /* c8 ignore next 2 -- a final transcript never yields pending-final */
      default:
        return { decision: "empty" };
    }
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
    return this.#dispatch(command);
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
    return this.#dispatch(pending.command);
  }

  #handleCancel(now: number, normalized: string): VoiceDispatch {
    this.#record(now, normalized, "cancel");
    const pending = this.#pending;
    if (!pending) return { decision: "confirmation-not-pending" };
    this.#pending = undefined;
    return { decision: "cancelled", command: pending.command };
  }

  async #dispatch(command: VoiceCommand): Promise<VoiceDispatch> {
    switch (command.kind) {
      case "query":
        return {
          decision: "query-unavailable",
          command,
          reason: "No read-only query provider is connected for this voice command.",
        };
      case "propose":
        return { decision: "proposed", command };
      case "actuate":
        return this.#actuate(command);
    }
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
