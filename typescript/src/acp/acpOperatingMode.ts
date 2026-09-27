/**
 * ACP operating-mode policy (roadmap PR H — governed commissioning slice).
 *
 * The strict ACP authority primitive lives in `acpContract.ts`
 * (`resolveAcpAuthorization`) and `acpTransport.ts` (`consultAcpPeer`): a peer
 * `allow` never authorises on its own, a `deny` is a veto, and a failed/invalid
 * consultation is fail-closed. That primitive is deliberately **not** changed by
 * this slice.
 *
 * This module is the layer *above* it: the operating-mode policy that decides how
 * much weight a consultation carries at a governed decision site. It is a pure
 * function of three inputs — the configured mode, whether the governed boundary
 * *independently* authorised the action, and the classified consultation result —
 * and it never itself consults, launches, or grants authority.
 *
 * Three modes, with locked semantics (see the two decision matrices below):
 *
 *   - **disabled**  ACP is not consulted at all; the governed decision alone
 *                   stands. A worker is never launched.
 *   - **advisory**  ACP is consulted for *evidence only*. It may disagree
 *                   (`deny`) or fail; neither changes the outcome. It can never
 *                   grant authority (no governed approval ⇒ block) and can never
 *                   remove independently valid governed authority (a disagreement
 *                   or failure is recorded, and execution proceeds).
 *   - **required**  ACP becomes an additional authority-*reducing* gate. It still
 *                   cannot create authority (no governed approval ⇒ block), but a
 *                   `deny`, or any failure/unavailability, blocks even a
 *                   governed-approved action.
 *
 * The failure taxonomy is operational *evidence*, never authority. An
 * unclassifiable failure is conservatively `internal_transport_error`, which
 * blocks in `required` mode and is recorded (execution proceeds) in `advisory`.
 */

export type AcpOperatingMode = "disabled" | "advisory" | "required";

/**
 * A classified consultation result. The first three are peer *decisions*; the
 * rest are *failures* (evidence, never authority). Keep new failure kinds in the
 * failure set below so mode policy treats them fail-closed.
 */
export type AcpConsultationClassification =
  | "allow"
  | "deny"
  | "abstain"
  | "unavailable"
  | "timeout"
  | "worker_crash"
  | "malformed_response"
  | "request_mismatch"
  | "output_limit_exceeded"
  | "internal_transport_error";

const ACP_DECISION_CLASSIFICATIONS: ReadonlySet<AcpConsultationClassification> = new Set([
  "allow",
  "deny",
  "abstain",
]);

const ACP_OPERATING_MODES: ReadonlySet<string> = new Set<AcpOperatingMode>([
  "disabled",
  "advisory",
  "required",
]);

/** Whether a classification is a peer decision (`allow`/`deny`/`abstain`). */
export function isAcpDecision(classification: AcpConsultationClassification): boolean {
  return ACP_DECISION_CLASSIFICATIONS.has(classification);
}

/** Whether a classification is a consultation *failure* (not a peer decision). */
export function isAcpConsultationFailure(classification: AcpConsultationClassification): boolean {
  return !ACP_DECISION_CLASSIFICATIONS.has(classification);
}

export type AcpModePolicyInput = Readonly<{
  mode: AcpOperatingMode;
  /**
   * Whether the governed boundary has *independently* authorised this action
   * (server-derived: the ToolAction is approved and not expired). This is the
   * only source of authority; the classification never sets it.
   */
  governedApprovalPresent: boolean;
  /**
   * The classified consultation result. Omitted only when the mode did not
   * consult (`disabled`, or a mode that blocks before consulting because no
   * governed approval exists).
   */
  classification?: AcpConsultationClassification;
}>;

export type AcpModePolicyOutcome = Readonly<{
  /** Whether the governed execution may proceed. */
  proceed: boolean;
  /**
   * True only for an `advisory` `deny` under a present governed approval: the
   * peer disagreed but execution proceeds. Recorded so the disagreement is not
   * silently discarded and can later inform an owner-approved policy change.
   */
  disagreement: boolean;
  /** Bounded, non-secret explanation of the decision. */
  reason: string;
}>;

/**
 * Resolve the mode policy. Pure; no I/O, no consultation, no authority creation.
 *
 * ADVISORY matrix                REQUIRED matrix
 * ─────────────────────────      ─────────────────────────
 * gov  result       outcome      gov  result       outcome
 * no   *            BLOCK        no   *            BLOCK
 * yes  allow        PROCEED      yes  allow        PROCEED
 * yes  abstain      PROCEED      yes  abstain      PROCEED
 * yes  deny         PROCEED*     yes  deny         BLOCK
 * yes  <failure>    PROCEED      yes  <failure>    BLOCK
 *   (* records a disagreement)
 *
 * DISABLED: `proceed = governedApprovalPresent`; ACP has no effect.
 */
export function resolveAcpModePolicy(input: AcpModePolicyInput): AcpModePolicyOutcome {
  if (input.mode === "disabled") {
    return {
      proceed: input.governedApprovalPresent,
      disagreement: false,
      reason: input.governedApprovalPresent
        ? "ACP disabled; governed approval present, so execution proceeds."
        : "ACP disabled; no governed approval, so execution is blocked.",
    };
  }

  // Both advisory and required: ACP can never grant authority.
  if (!input.governedApprovalPresent) {
    return {
      proceed: false,
      disagreement: false,
      reason: `ACP ${input.mode}: no independent governed approval; ACP cannot grant authority, so execution is blocked.`,
    };
  }

  const classification = input.classification;
  if (classification === undefined) {
    // A mode that reached here with a governed approval but no classification
    // means the peer was never actually consulted. Treat as unavailable so the
    // fail-closed rules below apply rather than silently proceeding.
    return resolveAcpModePolicy({ ...input, classification: "unavailable" });
  }

  if (input.mode === "advisory") {
    // Advisory never removes independently valid governed authority.
    if (classification === "deny") {
      return {
        proceed: true,
        disagreement: true,
        reason:
          "ACP advisory: peer denied, but advisory ACP cannot remove governed authority; proceeding and recording the disagreement.",
      };
    }
    if (isAcpConsultationFailure(classification)) {
      return {
        proceed: true,
        disagreement: false,
        reason: `ACP advisory: consultation failure (${classification}) recorded as evidence; governed authority stands, so execution proceeds.`,
      };
    }
    return {
      proceed: true,
      disagreement: false,
      reason: `ACP advisory: peer ${classification}; governed authority present, so execution proceeds.`,
    };
  }

  // required: a deny or any failure/unavailability blocks a governed-approved action.
  if (classification === "allow" || classification === "abstain") {
    return {
      proceed: true,
      disagreement: false,
      reason: `ACP required: peer ${classification} and governed approval present, so execution proceeds.`,
    };
  }
  return {
    proceed: false,
    disagreement: false,
    reason:
      classification === "deny"
        ? "ACP required: peer denied; a deny blocks even a governed-approved action."
        : `ACP required: consultation failure (${classification}); a failed required consultation blocks even a governed-approved action.`,
  };
}

/**
 * Resolve the operating mode from the environment, fail-safe to `disabled`.
 * Reads `${prefix}` (default `JARVIS_ACP_MODE`); an absent, blank, or
 * unrecognised value resolves to `disabled` so ACP stays dormant unless an owner
 * explicitly enables a mode. Case-insensitive.
 */
export function resolveAcpOperatingModeFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { key?: string } = {},
): AcpOperatingMode {
  const key = options.key ?? "JARVIS_ACP_MODE";
  const raw = environment[key]?.trim().toLowerCase();
  if (raw && ACP_OPERATING_MODES.has(raw)) return raw as AcpOperatingMode;
  return "disabled";
}
