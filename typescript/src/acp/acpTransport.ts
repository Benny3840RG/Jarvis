/**
 * ACP transport seam (roadmap PR H, slice 1).
 *
 * The ACP authority contract (`acpContract.ts`, AUTH-INV-05) says a peer agent's
 * permission response is advisory: an `allow` never authorises on its own, a
 * `deny` is a veto, and authority always rests on an independent governed
 * approval. This module is the transport-agnostic seam that carries such a
 * request/response to a peer and routes the answer through that gate — so no
 * transport (in-process now; a stdio or HTTP wire transport in a later slice)
 * can bypass the rule.
 *
 * Two properties are enforced here, both fail-closed:
 *
 *   1. Every peer response passes through {@link resolveAcpAuthorization}. The
 *      transport's raw answer is never returned as an authorisation.
 *   2. A response that is missing, malformed, mismatched, or thrown is treated
 *      as `abstain` — advisory-neutral. A broken or hostile transport therefore
 *      can never manufacture an `allow` (authority still requires the governed
 *      approval) and can at most fail to cast a veto. It cannot inject authority.
 *
 * Deliberately not in this slice: any wire transport (stdio/HTTP) or network.
 * The concrete transport — and its network-egress decision, like PR F's — is a
 * later slice. AUTH-INV-05 stays *planned*: nothing live routes through this
 * seam yet; this is the abstraction the wire transport must implement.
 */

import {
  resolveAcpAuthorization,
  type AcpAuthorizationOutcome,
  type AcpPermissionDecision,
  type AcpPermissionResponse,
} from "./acpContract.js";

/** A permission request sent to a peer agent over ACP. */
export type AcpPermissionRequest = Readonly<{
  requestId: string;
  action: string;
  detail?: string;
}>;

/**
 * A transport that carries an ACP permission request to a peer and returns its
 * response. Implementations (in-process here; stdio/HTTP later) must not embed
 * any authority — the response is advice, resolved by {@link consultAcpPeer}.
 */
export interface AcpTransport {
  requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
}

const VALID_DECISIONS: ReadonlySet<AcpPermissionDecision> = new Set(["allow", "deny", "abstain"]);

/**
 * Validate a raw transport answer against the request, fail-closed. Returns a
 * well-formed {@link AcpPermissionResponse}, or an `abstain` response when the
 * answer is missing, not an object, has the wrong `requestId`, or carries a
 * decision that is not one of the three known values. An `abstain` is
 * advisory-neutral: it can never authorise, so a malformed answer cannot be
 * turned into authority.
 */
function normaliseResponse(raw: unknown, request: AcpPermissionRequest): AcpPermissionResponse {
  if (typeof raw !== "object" || raw === null) {
    return { requestId: request.requestId, decision: "abstain" };
  }
  const candidate = raw as { requestId?: unknown; decision?: unknown; reason?: unknown };
  const decision = candidate.decision;
  if (
    candidate.requestId !== request.requestId ||
    typeof decision !== "string" ||
    !VALID_DECISIONS.has(decision as AcpPermissionDecision)
  ) {
    return { requestId: request.requestId, decision: "abstain" };
  }
  return {
    requestId: request.requestId,
    decision: decision as AcpPermissionDecision,
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
  };
}

export type ConsultAcpPeerInput = Readonly<{
  transport: AcpTransport;
  request: AcpPermissionRequest;
  /**
   * Whether the governed execution boundary has independently authorised this
   * action. The only source of authority; the ACP response never sets it.
   */
  governedApprovalPresent: boolean;
}>;

/**
 * Consult a peer over ACP and resolve authorisation. The peer's answer is
 * normalised fail-closed and then routed through {@link resolveAcpAuthorization}
 * — the transport can never authorise directly. A transport that throws is
 * treated as `abstain` (advisory-neutral), so an unreachable or hostile peer
 * cannot block a governed-approved action nor manufacture one.
 */
export async function consultAcpPeer(input: ConsultAcpPeerInput): Promise<AcpAuthorizationOutcome> {
  let raw: unknown;
  try {
    raw = await input.transport.requestPermission(input.request);
  } catch {
    // The transport failed; treat the peer as abstaining (never allow/deny).
    raw = undefined;
  }
  const acp = normaliseResponse(raw, input.request);
  return resolveAcpAuthorization({ acp, governedApprovalPresent: input.governedApprovalPresent });
}

/**
 * A local, in-process ACP transport for tests and for co-located agents: it
 * delegates to a handler function instead of any wire. No network, no
 * serialization — the seam works without a wire transport existing yet.
 */
export class InProcessAcpTransport implements AcpTransport {
  readonly #handler: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;

  constructor(handler: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>) {
    this.#handler = handler;
  }

  async requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    return this.#handler(request);
  }
}
