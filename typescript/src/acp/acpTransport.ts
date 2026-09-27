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
 *   1. Every valid peer response passes through {@link resolveAcpAuthorization}.
 *      The transport's raw answer is never returned as an authorisation.
 *   2. A consultation that fails — the transport throws, or returns something
 *      missing, malformed, or with a mismatched `requestId` — is **indeterminate**,
 *      not an abstention: it resolves to *not authorised* even when a governed
 *      approval is present. This is deliberate. Mapping a failure to `abstain`
 *      would let a crash, timeout, flood, or malformed/mismatched answer
 *      *suppress a veto* the peer would have cast, once governed approval exists.
 *      Only an **explicit** `abstain` from a reachable peer defers to the
 *      governed decision. A broken or hostile transport still can never
 *      manufacture an `allow`.
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
 * well-formed {@link AcpPermissionResponse}, or `null` when the answer is
 * missing, not an object, has the wrong `requestId`, or carries a decision that
 * is not one of the three known values. `null` means "no valid response" —
 * {@link consultAcpPeer} treats it as indeterminate (blocked), never as an
 * abstention, so a malformed/mismatched answer cannot silently pass a veto.
 */
function normaliseResponse(
  raw: unknown,
  request: AcpPermissionRequest,
): AcpPermissionResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { requestId?: unknown; decision?: unknown; reason?: unknown };
  const decision = candidate.decision;
  if (
    candidate.requestId !== request.requestId ||
    typeof decision !== "string" ||
    !VALID_DECISIONS.has(decision as AcpPermissionDecision)
  ) {
    return null;
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
 * Consult a peer over ACP and resolve authorisation. A *valid* peer answer is
 * routed through {@link resolveAcpAuthorization} — the transport can never
 * authorise directly. A *failed* consultation (the transport throws, or returns
 * a missing/malformed/mismatched answer, including a hostile object whose
 * getters throw) is **indeterminate**: it resolves to not authorised regardless
 * of `governedApprovalPresent`, so a crash, timeout, flood, or bad answer can
 * never suppress a veto. Only an explicit `abstain` from a reachable peer defers
 * to the governed decision.
 */
export async function consultAcpPeer(input: ConsultAcpPeerInput): Promise<AcpAuthorizationOutcome> {
  let acp: AcpPermissionResponse | null;
  try {
    const raw = await input.transport.requestPermission(input.request);
    acp = normaliseResponse(raw, input.request);
  } catch {
    acp = null;
  }
  if (acp === null) {
    // Fail-closed (AUTH-INV-05): a failed/invalid consultation is not an
    // abstention. It must not authorise even with governed approval — otherwise
    // an unreachable, crashing, flooding, or malformed peer could erase a veto.
    return {
      authorised: false,
      reason:
        "ACP consultation failed or returned no valid response; treated as indeterminate (fail-closed): the action cannot proceed without a valid peer response, even with a governed approval.",
    };
  }
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
