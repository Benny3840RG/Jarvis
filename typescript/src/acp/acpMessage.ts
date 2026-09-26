/**
 * ACP wire framing (roadmap PR H, slice 2).
 *
 * A concrete ACP transport (stdio or HTTP, a later slice) must serialise the
 * two permission messages the seam carries — an outbound {@link AcpPermissionRequest}
 * and an inbound {@link AcpPermissionResponse}. This module is the
 * transport-agnostic wire format they share: a versioned, discriminated
 * envelope and a **fail-closed decoder**.
 *
 * Security property: {@link decodeAcpEnvelope} never throws and never coerces a
 * malformed or hostile payload into a valid message — it returns `null` for
 * anything that is not exactly a known envelope (bad JSON, wrong version,
 * unknown kind, missing/blank/mistyped fields). A wire transport that gets
 * `null` yields no usable response, and the authority seam
 * ({@link consultAcpPeer}) already treats a missing/malformed response as
 * `abstain`. The framing layer carries no authority: decoding a
 * `permission_response` frame only produces the typed response; it still must
 * pass through {@link resolveAcpAuthorization}. Only known fields survive a
 * decode, so a frame cannot smuggle extra data downstream.
 *
 * No transport, no network here — this is the format the wire transport must
 * use. The concrete transport and its egress decision are the next slice.
 */

import type { AcpPermissionDecision, AcpPermissionResponse } from "./acpContract.js";
import type { AcpPermissionRequest } from "./acpTransport.js";

/** The one wire-format version this module speaks. Bumped on a breaking change. */
export const ACP_WIRE_VERSION = 1 as const;

/** A framed ACP message: exactly one of a permission request or response. */
export type AcpWireEnvelope =
  | { readonly v: 1; readonly kind: "permission_request"; readonly request: AcpPermissionRequest }
  | {
      readonly v: 1;
      readonly kind: "permission_response";
      readonly response: AcpPermissionResponse;
    };

const VALID_DECISIONS: ReadonlySet<AcpPermissionDecision> = new Set(["allow", "deny", "abstain"]);

/** Encode an envelope for the wire. */
export function encodeAcpEnvelope(envelope: AcpWireEnvelope): string {
  return JSON.stringify(envelope);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Rebuild an {@link AcpPermissionRequest} from raw, or null if malformed. */
function decodeRequest(raw: unknown): AcpPermissionRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { requestId?: unknown; action?: unknown; detail?: unknown };
  if (!nonEmptyString(candidate.requestId) || !nonEmptyString(candidate.action)) return null;
  if (candidate.detail !== undefined && typeof candidate.detail !== "string") return null;
  return Object.freeze({
    requestId: candidate.requestId,
    action: candidate.action,
    ...(typeof candidate.detail === "string" ? { detail: candidate.detail } : {}),
  });
}

/** Rebuild an {@link AcpPermissionResponse} from raw, or null if malformed. */
function decodeResponse(raw: unknown): AcpPermissionResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { requestId?: unknown; decision?: unknown; reason?: unknown };
  if (!nonEmptyString(candidate.requestId)) return null;
  if (
    typeof candidate.decision !== "string" ||
    !VALID_DECISIONS.has(candidate.decision as AcpPermissionDecision)
  ) {
    return null;
  }
  if (candidate.reason !== undefined && typeof candidate.reason !== "string") return null;
  return Object.freeze({
    requestId: candidate.requestId,
    decision: candidate.decision as AcpPermissionDecision,
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
  });
}

/**
 * Decode a wire payload into an {@link AcpWireEnvelope}, fail-closed: returns
 * `null` for invalid JSON, a version other than {@link ACP_WIRE_VERSION}, an
 * unknown `kind`, or a malformed payload. Never throws; only known fields
 * survive.
 */
export function decodeAcpEnvelope(raw: string): AcpWireEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { v?: unknown; kind?: unknown; request?: unknown; response?: unknown };
  if (frame.v !== ACP_WIRE_VERSION) return null;

  if (frame.kind === "permission_request") {
    const request = decodeRequest(frame.request);
    return request ? { v: 1, kind: "permission_request", request } : null;
  }
  if (frame.kind === "permission_response") {
    const response = decodeResponse(frame.response);
    return response ? { v: 1, kind: "permission_response", response } : null;
  }
  return null;
}
