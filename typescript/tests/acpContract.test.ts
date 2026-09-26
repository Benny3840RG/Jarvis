import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acpResponseAloneAuthorises,
  type AcpPermissionResponse,
  resolveAcpAuthorization,
} from "../src/acp/acpContract.js";

function response(
  decision: AcpPermissionResponse["decision"],
  requestId = "req-1",
): AcpPermissionResponse {
  return { requestId, decision };
}

describe("ACP authority contract (PR G, AUTH-INV-05)", () => {
  it("never lets an ACP response authorise on its own", () => {
    for (const decision of ["allow", "deny", "abstain"] as const) {
      assert.equal(acpResponseAloneAuthorises(response(decision)), false, decision);
    }
  });

  it("refuses an ACP allow without an independent governed approval", () => {
    const outcome = resolveAcpAuthorization({
      acp: response("allow"),
      governedApprovalPresent: false,
    });
    assert.equal(outcome.authorised, false);
    assert.match(outcome.reason, /advisory|governed approval is required/);
  });

  it("authorises only when governed approval is present, and credits the governed boundary", () => {
    const outcome = resolveAcpAuthorization({
      acp: response("allow"),
      governedApprovalPresent: true,
    });
    assert.equal(outcome.authorised, true);
    assert.match(outcome.reason, /did not by itself authorise/);
  });

  it("treats an ACP deny as a veto even with governed approval present", () => {
    const outcome = resolveAcpAuthorization({
      acp: response("deny"),
      governedApprovalPresent: true,
    });
    assert.equal(outcome.authorised, false);
    assert.match(outcome.reason, /veto/);
  });

  it("lets abstain fall through to the governed approval, which alone decides", () => {
    assert.equal(
      resolveAcpAuthorization({ acp: response("abstain"), governedApprovalPresent: true })
        .authorised,
      true,
    );
    assert.equal(
      resolveAcpAuthorization({ acp: response("abstain"), governedApprovalPresent: false })
        .authorised,
      false,
    );
  });
});
