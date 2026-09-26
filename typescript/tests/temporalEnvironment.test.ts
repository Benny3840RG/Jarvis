import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  probeTemporalEnvironment,
  resolveTemporalEnvironment,
  TemporalEnvironmentError,
} from "../src/preview/temporalPass/temporal/environment.js";
import {
  runTemporalReadiness,
  validateTemporalSourceVersion,
} from "../src/tools/runTemporalReadiness.js";

const SHA = "a".repeat(40);

describe("Temporal environment readiness", () => {
  it("uses local defaults without claiming an explicit environment exists", () => {
    assert.deepEqual(resolveTemporalEnvironment({}), {
      address: "localhost:7233",
      namespace: "default",
      configured: false,
      required: false,
      addressSource: "default",
      namespaceSource: "default",
    });
  });

  it("resolves an explicitly configured Temporal environment", () => {
    assert.deepEqual(
      resolveTemporalEnvironment({
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "jarvis-dev",
        JARVIS_TEMPORAL_REQUIRED: "true",
      }),
      {
        address: "temporal.internal:7233",
        namespace: "jarvis-dev",
        configured: true,
        required: true,
        addressSource: "environment",
        namespaceSource: "environment",
      },
    );
  });

  it("fails closed on blank or invalid explicit Temporal configuration", () => {
    for (const env of [
      { TEMPORAL_ADDRESS: " " },
      { TEMPORAL_NAMESPACE: "\t" },
      { JARVIS_TEMPORAL_REQUIRED: "maybe" },
      { JARVIS_TEMPORAL_REQUIRED: "" },
    ]) {
      assert.throws(() => resolveTemporalEnvironment(env), TemporalEnvironmentError);
    }
  });

  it("accepts explicit true and false required values", () => {
    for (const value of ["1", "true", "yes", "on", "ON"]) {
      assert.equal(resolveTemporalEnvironment({ JARVIS_TEMPORAL_REQUIRED: value }).required, true);
    }
    for (const value of ["0", "false", "no", "off", "OFF"]) {
      assert.equal(resolveTemporalEnvironment({ JARVIS_TEMPORAL_REQUIRED: value }).required, false);
    }
  });

  it("reports reachable without claiming commissioning evidence", async () => {
    let closed = false;
    const result = await probeTemporalEnvironment(
      {
        TEMPORAL_ADDRESS: "temporal.internal:7233",
        TEMPORAL_NAMESPACE: "jarvis-dev",
      },
      async (address) => {
        assert.equal(address, "temporal.internal:7233");
        return {
          close: async () => {
            closed = true;
          },
        };
      },
    );

    assert.equal(closed, true);
    assert.deepEqual(result, {
      stage: "reachable",
      configured: true,
      present: true,
      reachable: true,
      commissioned: false,
      addressSource: "environment",
      namespaceSource: "environment",
      reason: "Temporal accepted a client connection; commissioning evidence is not claimed.",
    });
  });

  it("keeps an unreachable optional environment at configured rather than commissioned", async () => {
    const result = await probeTemporalEnvironment(
      { TEMPORAL_ADDRESS: "temporal.internal:7233" },
      async () => {
        throw new Error("password=should-never-appear");
      },
    );

    assert.deepEqual(result, {
      stage: "configured",
      configured: true,
      present: true,
      reachable: false,
      commissioned: false,
      addressSource: "environment",
      namespaceSource: "default",
      reason: "Temporal is configured but a client connection could not be established.",
    });
    assert.equal(JSON.stringify(result).includes("should-never-appear"), false);
  });

  it("reports absent when only defaults exist and no Temporal server is reachable", async () => {
    const result = await probeTemporalEnvironment({}, async () => {
      throw new Error("offline");
    });

    assert.equal(result.stage, "absent");
    assert.equal(result.configured, false);
    assert.equal(result.present, false);
    assert.equal(result.reachable, false);
    assert.equal(result.commissioned, false);
  });

  it("fails closed when Temporal is required but cannot be reached without leaking connector errors", async () => {
    await assert.rejects(
      probeTemporalEnvironment(
        {
          TEMPORAL_ADDRESS: "temporal.internal:7233",
          JARVIS_TEMPORAL_REQUIRED: "1",
        },
        async () => {
          throw new Error("token=super-secret");
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TemporalEnvironmentError);
        assert.equal(
          error.message,
          "Temporal is required but a client connection could not be established.",
        );
        assert.equal(error.message.includes("super-secret"), false);
        return true;
      },
    );
  });

  it("binds a readiness receipt to an exact source SHA without logging endpoint values", async () => {
    const receipt = await runTemporalReadiness(
      {
        TEMPORAL_ADDRESS: "secret-host.internal:7233",
        TEMPORAL_NAMESPACE: "private-namespace",
      },
      SHA.toUpperCase(),
      async () => ({ close: () => undefined }),
    );

    assert.equal(receipt.sourceVersion, SHA);
    assert.equal(receipt.stage, "reachable");
    assert.equal(receipt.commissioned, false);
    assert.equal(JSON.stringify(receipt).includes("secret-host"), false);
    assert.equal(JSON.stringify(receipt).includes("private-namespace"), false);
  });

  it("requires exact source identity for readiness evidence", () => {
    assert.equal(validateTemporalSourceVersion(SHA.toUpperCase()), SHA);
    for (const invalid of ["main", SHA.slice(0, 12), `${SHA}0`, ""]) {
      assert.throws(() => validateTemporalSourceVersion(invalid));
    }
  });
});
