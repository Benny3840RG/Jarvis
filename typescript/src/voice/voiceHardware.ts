/**
 * Jarvis guarded voice interface — hardware actuation boundary (#567).
 *
 * The voice session never touches equipment directly; it asks a
 * `VoiceActuationProvider`. No hardware adapter ships in `main`, so the only
 * provider here is {@link AbsentHardwareProvider}, which reports every target
 * unavailable and NEVER returns a simulated acknowledgement. That is the
 * "absent equipment remains unavailable; no simulated acknowledgements"
 * acceptance criterion, enforced in `tests/voiceSession.test.ts`.
 *
 * A real adapter, when one is commissioned, implements this same interface and
 * is the only thing permitted to return `status: "actuated"`.
 */

export type HardwareAvailability = "available" | "unavailable";

export type ActuationResult =
  /** The hardware acknowledged the actuation. Only a real adapter may return this. */
  | Readonly<{ status: "actuated"; target: string }>
  /** The target cannot be actuated right now; nothing happened. */
  | Readonly<{ status: "unavailable"; target: string; reason: string }>
  /** The adapter attempted actuation and it failed; treat as fail-closed. */
  | Readonly<{ status: "failed"; target: string; reason: string }>;

export interface VoiceActuationProvider {
  /** Whether a hardware target can currently be actuated. */
  statusOf(target: string): HardwareAvailability;
  /** Attempt actuation. Must never fabricate success for absent hardware. */
  actuate(input: { target: string; commandId: string }): Promise<ActuationResult>;
}

/**
 * The provider wired in `main`: there is no hardware adapter, so everything is
 * unavailable and nothing is ever acknowledged.
 */
export class AbsentHardwareProvider implements VoiceActuationProvider {
  statusOf(_target: string): HardwareAvailability {
    return "unavailable";
  }

  async actuate(input: { target: string; commandId: string }): Promise<ActuationResult> {
    return {
      status: "unavailable",
      target: input.target,
      reason: "No hardware adapter is commissioned for this Jarvis deployment.",
    };
  }
}
