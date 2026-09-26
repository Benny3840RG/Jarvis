/**
 * ACP (Agent Communication Protocol) authority contract (roadmap PR G).
 *
 * ACP is a transport for agents to exchange permission requests and responses.
 * The acquisition plan brings it in as an *acquired* capability that must sit
 * underneath Jarvis authority: a peer agent's permission response is advice,
 * never authorisation. AUTH-INV-05 forbids "an ACP permission response becomes
 * authoritative by itself" — an ACP `allow` cannot, on its own, let any action
 * proceed; the action still requires an independent governed approval
 * (ΩΣ / ToolAction / claim + Benny), and a `deny` is a veto that governed
 * approval cannot override.
 *
 * This module is that rule, declared contract-first before any ACP transport
 * exists (like the authority, telemetry, and GitHub-read-plane contracts):
 * `resolveAcpAuthorization` is the single gate the future transport (PR H, when
 * Claude and Codex move onto ACP) must route through, so the "ACP is advisory"
 * property is enforced, not assumed. `tests/acpContract.test.ts` holds it.
 */

export type AcpPermissionDecision = "allow" | "deny" | "abstain";

/** A permission response from a peer agent over ACP. Advisory input only. */
export type AcpPermissionResponse = Readonly<{
  requestId: string;
  decision: AcpPermissionDecision;
  reason?: string;
}>;

export type AcpAuthorizationInput = Readonly<{
  acp: AcpPermissionResponse;
  /**
   * Whether the governed execution boundary has *independently* authorised this
   * action (owner-approved claim / receipt). This is the only source of
   * authority; the ACP response never sets it.
   */
  governedApprovalPresent: boolean;
}>;

export type AcpAuthorizationOutcome = Readonly<{
  authorised: boolean;
  reason: string;
}>;

/**
 * Whether an ACP response, considered entirely on its own, authorises an
 * action. Always `false` — encodes AUTH-INV-05 directly: ACP is a transport,
 * not an authority source. Exists so the rule is a referenced constant, not
 * folk knowledge.
 */
export function acpResponseAloneAuthorises(_response: AcpPermissionResponse): false {
  return false;
}

/**
 * Resolve whether an action is authorised given a peer's ACP response and
 * whether the governed boundary independently approved it.
 *
 *  - A governed approval is *required*: without it, even an ACP `allow` does
 *    not authorise (this is the heart of AUTH-INV-05).
 *  - An ACP `deny` is a veto: it blocks even when governed approval is present,
 *    so a peer can refuse but never unilaterally permit.
 *  - `abstain` carries no opinion; authority rests solely on the governed
 *    approval.
 */
export function resolveAcpAuthorization(input: AcpAuthorizationInput): AcpAuthorizationOutcome {
  if (input.acp.decision === "deny") {
    return { authorised: false, reason: "ACP peer denied; a deny is a veto." };
  }
  if (!input.governedApprovalPresent) {
    return {
      authorised: false,
      reason: "ACP response is advisory; an independent governed approval is required.",
    };
  }
  return {
    authorised: true,
    reason: "Governed approval present; the ACP response did not by itself authorise.",
  };
}
