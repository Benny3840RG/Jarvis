import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPostHogTelemetryFromEnv } from "../src/observability/posthog.js";
import { REDACTED } from "../src/observability/telemetryContract.js";

function developmentEnv(): NodeJS.ProcessEnv {
  return {
    JARVIS_ENVIRONMENT: "development",
    JARVIS_POSTHOG_ENABLED: "true",
    POSTHOG_PROJECT_API_KEY: "phc_development_test_key",
    POSTHOG_HOST: "https://example.test",
    POSTHOG_TIMEOUT_MS: "25",
  };
}

describe("PostHog telemetry redaction boundary", () => {
  it("masks sensitively-named properties before sending, keeping benign ones", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    };
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), fetchImpl);
    assert.equal(telemetry.enabled, true);

    telemetry.capture({
      event: "jarvis.operator_action",
      properties: {
        operation: "http_request",
        outcome: "success",
        // A sensitively-named property a future caller might add.
        serviceToken: "phc-super-secret",
      },
    });
    await telemetry.flush();

    assert.equal(bodies.length, 1);
    const properties = bodies[0]?.properties as Record<string, unknown>;
    assert.equal(properties.operation, "http_request");
    assert.equal(properties.outcome, "success");
    assert.equal(properties.serviceToken, REDACTED);
    // The emitter's own additions survive and are not sensitive.
    assert.equal(properties.source_version, "development");
    assert.equal(properties.$geoip_disable, true);
  });
});
