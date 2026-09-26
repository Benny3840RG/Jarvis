import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consultAcpPeer,
  InProcessAcpTransport,
  type AcpPermissionRequest,
  type AcpTransport,
} from "../src/acp/acpTransport.js";
import type { AcpPermissionResponse } from "../src/acp/acpContract.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "merge_pull_request",
});

/** A transport that returns whatever it is handed, for shaping each case. */
function fixedTransport(response: unknown): AcpTransport {
  return { requestPermission: async () => response as AcpPermissionResponse };
}

describe("ACP transport seam (PR H, slice 1)", () => {
  it("authorises only when the peer allows AND governed approval is present", async () => {
    const transport = new InProcessAcpTransport(async () => ({
      requestId: "req-1",
      decision: "allow",
    }));
    const outcome = await consultAcpPeer({
      transport,
      request: REQUEST,
      governedApprovalPresent: true,
    });
    assert.equal(outcome.authorised, true);
  });

  it("does not authorise on a peer allow when governed approval is absent (advisory only)", async () => {
    const outcome = await consultAcpPeer({
      transport: fixedTransport({ requestId: "req-1", decision: "allow" }),
      request: REQUEST,
      governedApprovalPresent: false,
    });
    assert.equal(outcome.authorised, false);
  });

  it("treats a peer deny as a veto even with governed approval present", async () => {
    const outcome = await consultAcpPeer({
      transport: fixedTransport({ requestId: "req-1", decision: "deny" }),
      request: REQUEST,
      governedApprovalPresent: true,
    });
    assert.equal(outcome.authorised, false);
  });

  it("fails closed to abstain when the transport throws — never manufactures authority", async () => {
    const transport: AcpTransport = {
      requestPermission: async () => {
        throw new Error("peer unreachable");
      },
    };
    // A broken transport can never authorise on its own...
    const withoutGoverned = await consultAcpPeer({
      transport,
      request: REQUEST,
      governedApprovalPresent: false,
    });
    assert.equal(withoutGoverned.authorised, false);
    // ...and never vetoes a governed-approved action (it is advisory, not a gate).
    const withGoverned = await consultAcpPeer({
      transport,
      request: REQUEST,
      governedApprovalPresent: true,
    });
    assert.equal(withGoverned.authorised, true);
    assert.match(withGoverned.reason, /abstain|advisory|governed/i);
  });

  it("treats a malformed or mismatched response as abstain (fail-closed), never allow", async () => {
    const malformed: unknown[] = [
      { requestId: "req-1", decision: "yes-please" }, // invalid decision
      { requestId: "WRONG", decision: "allow" }, // requestId mismatch
      { decision: "allow" }, // missing requestId
      "allow", // not an object
      null,
      { requestId: "req-1" }, // missing decision
    ];
    for (const response of malformed) {
      // Without governed approval, a forged "allow" must not authorise.
      const outcome = await consultAcpPeer({
        transport: fixedTransport(response),
        request: REQUEST,
        governedApprovalPresent: false,
      });
      assert.equal(outcome.authorised, false, JSON.stringify(response));
    }
  });

  it("fails closed to abstain when a response getter throws (hostile object/Proxy)", async () => {
    // A returned object whose property access throws must normalise to abstain,
    // not propagate as a rejection.
    const hostile = {
      get requestId(): string {
        throw new Error("boom");
      },
      get decision(): string {
        throw new Error("boom");
      },
    };
    const withoutGoverned = await consultAcpPeer({
      transport: fixedTransport(hostile),
      request: REQUEST,
      governedApprovalPresent: false,
    });
    assert.equal(withoutGoverned.authorised, false);
    const withGoverned = await consultAcpPeer({
      transport: fixedTransport(hostile),
      request: REQUEST,
      governedApprovalPresent: true,
    });
    assert.equal(withGoverned.authorised, true);
  });

  it("never lets the transport response authorise without the governed gate", async () => {
    // Even a well-formed allow is inert on its own — the gate decides.
    const outcome = await consultAcpPeer({
      transport: fixedTransport({ requestId: "req-1", decision: "allow", reason: "peer says ok" }),
      request: REQUEST,
      governedApprovalPresent: false,
    });
    assert.equal(outcome.authorised, false);
    assert.match(outcome.reason, /advisory|governed/i);
  });

  it("InProcessAcpTransport echoes the request id to its handler", async () => {
    let seen: string | undefined;
    const transport = new InProcessAcpTransport(async (request) => {
      seen = request.requestId;
      return { requestId: request.requestId, decision: "abstain" };
    });
    await consultAcpPeer({ transport, request: REQUEST, governedApprovalPresent: true });
    assert.equal(seen, "req-1");
  });
});
