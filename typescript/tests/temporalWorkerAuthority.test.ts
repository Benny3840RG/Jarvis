import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPROVAL_CREDENTIAL_ENV_VARS,
  assertWorkerHoldsNoApprovalCredential,
  WorkerAuthorityError,
} from "../src/preview/temporalPass/temporal/workerAuthority.js";

describe("Temporal worker authority guard", () => {
  it("passes when the worker holds no approval credential", () => {
    assert.doesNotThrow(() => assertWorkerHoldsNoApprovalCredential({}));
    assert.doesNotThrow(() =>
      assertWorkerHoldsNoApprovalCredential({ TEMPORAL_ADDRESS: "localhost:7233" }),
    );
  });

  it("fails a versioned worker that holds an approval credential", () => {
    for (const name of APPROVAL_CREDENTIAL_ENV_VARS) {
      assert.throws(
        () => assertWorkerHoldsNoApprovalCredential({ [name]: "secret-token" }),
        WorkerAuthorityError,
        name,
      );
    }
  });

  it("treats a blank or whitespace-only credential as unset", () => {
    assert.doesNotThrow(() => assertWorkerHoldsNoApprovalCredential({ JARVIS_APPROVAL_TOKEN: "" }));
    assert.doesNotThrow(() =>
      assertWorkerHoldsNoApprovalCredential({ JARVIS_APPROVAL_TOKEN: "   " }),
    );
  });

  it("names every credential env var that is set", () => {
    try {
      assertWorkerHoldsNoApprovalCredential({
        JARVIS_APPROVAL_TOKEN: "a",
        JARVIS_APPROVAL_TOKEN_PREVIOUS: "b",
      });
      assert.fail("expected WorkerAuthorityError");
    } catch (error) {
      assert.ok(error instanceof WorkerAuthorityError);
      for (const name of APPROVAL_CREDENTIAL_ENV_VARS)
        assert.match(error.message, new RegExp(name));
    }
  });
});
