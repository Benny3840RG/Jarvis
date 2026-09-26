import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACP_WIRE_VERSION,
  decodeAcpEnvelope,
  encodeAcpEnvelope,
  type AcpWireEnvelope,
} from "../src/acp/acpMessage.js";

const REQUEST_ENVELOPE: AcpWireEnvelope = {
  v: 1,
  kind: "permission_request",
  request: { requestId: "req-1", action: "merge_pull_request", detail: "PR #42" },
};
const RESPONSE_ENVELOPE: AcpWireEnvelope = {
  v: 1,
  kind: "permission_response",
  response: { requestId: "req-1", decision: "allow", reason: "looks fine" },
};

describe("ACP wire framing (PR H, slice 2)", () => {
  it("round-trips a permission request and response", () => {
    for (const envelope of [REQUEST_ENVELOPE, RESPONSE_ENVELOPE]) {
      const decoded = decodeAcpEnvelope(encodeAcpEnvelope(envelope));
      assert.deepEqual(decoded, envelope);
    }
  });

  it("round-trips messages without the optional fields", () => {
    const req: AcpWireEnvelope = {
      v: 1,
      kind: "permission_request",
      request: { requestId: "r", action: "read" },
    };
    const res: AcpWireEnvelope = {
      v: 1,
      kind: "permission_response",
      response: { requestId: "r", decision: "abstain" },
    };
    assert.deepEqual(decodeAcpEnvelope(encodeAcpEnvelope(req)), req);
    assert.deepEqual(decodeAcpEnvelope(encodeAcpEnvelope(res)), res);
  });

  it("drops unknown fields on decode (only known shape survives)", () => {
    const raw = JSON.stringify({
      v: 1,
      kind: "permission_response",
      response: { requestId: "r", decision: "deny", reason: "no", extra: "x" },
      trailing: "y",
    });
    assert.deepEqual(decodeAcpEnvelope(raw), {
      v: 1,
      kind: "permission_response",
      response: { requestId: "r", decision: "deny", reason: "no" },
    });
  });

  it("decodes fail-closed to null on malformed input, never throwing", () => {
    const bad: string[] = [
      "", // empty
      "not json",
      "null",
      "42",
      "[]",
      JSON.stringify({ kind: "permission_request", request: { requestId: "r", action: "a" } }), // no version
      JSON.stringify({
        v: 2,
        kind: "permission_request",
        request: { requestId: "r", action: "a" },
      }), // wrong version
      JSON.stringify({ v: 1, kind: "nonsense", request: {} }), // unknown kind
      JSON.stringify({ v: 1, kind: "permission_request" }), // missing request
      JSON.stringify({ v: 1, kind: "permission_request", request: { action: "a" } }), // missing requestId
      JSON.stringify({ v: 1, kind: "permission_request", request: { requestId: "", action: "a" } }), // blank requestId
      JSON.stringify({ v: 1, kind: "permission_request", request: { requestId: "r", action: "" } }), // blank action
      JSON.stringify({
        v: 1,
        kind: "permission_request",
        request: { requestId: "   ", action: "a" },
      }), // whitespace-only requestId
      JSON.stringify({
        v: 1,
        kind: "permission_request",
        request: { requestId: "r", action: "\t\n" },
      }), // whitespace-only action
      JSON.stringify({
        v: 1,
        kind: "permission_response",
        response: { requestId: "  ", decision: "allow" },
      }), // whitespace-only requestId
      JSON.stringify({ v: 1, kind: "permission_response", response: { requestId: "r" } }), // missing decision
      JSON.stringify({
        v: 1,
        kind: "permission_response",
        response: { requestId: "r", decision: "maybe" },
      }), // invalid decision
      JSON.stringify({
        v: 1,
        kind: "permission_response",
        response: { requestId: "r", decision: "allow", reason: 5 },
      }), // non-string reason
    ];
    for (const raw of bad) {
      assert.equal(decodeAcpEnvelope(raw), null, raw);
    }
  });

  it("exposes the wire version constant", () => {
    assert.equal(ACP_WIRE_VERSION, 1);
  });
});
