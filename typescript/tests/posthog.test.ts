import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  captureHttpBoundary,
  captureMcpBoundary,
  captureReconciliationCycle,
  createPostHogCommissioningTelemetryFromEnv,
  createPostHogTelemetryFromEnv,
} from "../src/observability/posthog.js";

type FetchCall = {
  input: string;
  init: RequestInit;
};

function developmentEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    JARVIS_ENVIRONMENT: "development",
    JARVIS_POSTHOG_ENABLED: "true",
    POSTHOG_PROJECT_API_KEY: "phc_development_test_key",
    POSTHOG_HOST: "https://example.test",
    POSTHOG_TIMEOUT_MS: "25",
    ...overrides,
  };
}

function createFetchRecorder(): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return new Response(null, { status: 204 });
  };
  return { calls, fetchImpl };
}

describe("PostHog runtime telemetry", () => {
  it("is inert when development telemetry is not explicitly enabled", async () => {
    const recorder = createFetchRecorder();
    const telemetry = createPostHogTelemetryFromEnv(
      { JARVIS_ENVIRONMENT: "development" },
      recorder.fetchImpl,
    );

    captureHttpBoundary(telemetry, {
      method: "GET",
      statusCode: 200,
      durationMs: 12,
    });
    await telemetry.flush();

    assert.equal(telemetry.enabled, false);
    assert.equal(recorder.calls.length, 0);
  });

  it("fails closed for malformed PostHog configuration", async () => {
    const recorder = createFetchRecorder();
    const telemetry = createPostHogTelemetryFromEnv(
      developmentEnv({ POSTHOG_HOST: "http://example.test" }),
      recorder.fetchImpl,
    );

    captureHttpBoundary(telemetry, {
      method: "POST",
      statusCode: 500,
      durationMs: 20,
    });
    await telemetry.flush();

    assert.equal(telemetry.enabled, false);
    assert.equal(recorder.calls.length, 0);
  });

  it("sends only the governed boundary event shape", async () => {
    const recorder = createFetchRecorder();
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), recorder.fetchImpl);

    captureHttpBoundary(telemetry, {
      method: "POST",
      statusCode: 201,
      durationMs: 37,
    });
    captureMcpBoundary(telemetry, {
      outcome: "failure",
      durationMs: 41,
    });
    captureReconciliationCycle(telemetry, {
      outcome: "success",
      processed: 3,
      failureCount: 0,
      durationMs: 52,
    });
    const receipt = await telemetry.flush();

    assert.equal(telemetry.enabled, true);
    assert.equal(recorder.calls.length, 10);
    assert.deepEqual(receipt, { attempted: 10, accepted: 10, failed: 0 });

    for (const call of recorder.calls) {
      assert.equal(call.input, "https://example.test/i/v0/e/");
      const body = JSON.parse(String(call.init.body)) as {
        api_key: string;
        distinct_id: string;
        event: string;
        properties: Record<string, unknown>;
      };
      assert.equal(body.api_key, "phc_development_test_key");
      assert.equal(body.distinct_id, "jarvis-development");
      assert.match(
        body.event,
        /^jarvis\.(operator_action|tool_outcome|boundary_latency|runtime_failure|usage)$/,
      );
      assert.equal(body.properties.environment, "development");
      assert.equal(body.properties.source_version, "development");
      assert.equal(body.properties.$geoip_disable, true);
      assert.equal("distinct_id" in body.properties, false);
      assert.equal("prompt" in body.properties, false);
      assert.equal("tokens" in body.properties, false);
      assert.equal("credentials" in body.properties, false);
      assert.equal("message_body" in body.properties, false);
      assert.equal("quote_data" in body.properties, false);
      assert.equal("payload" in body.properties, false);
    }
  });

  it("classifies HTTP client errors and failed reconciliation work as failures", async () => {
    const recorder = createFetchRecorder();
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), recorder.fetchImpl);

    captureHttpBoundary(telemetry, { method: "GET", statusCode: 401, durationMs: 5 });
    captureReconciliationCycle(telemetry, {
      outcome: "success",
      processed: 2,
      failureCount: 1,
      durationMs: 8,
    });
    await telemetry.flush();

    const events = recorder.calls.map((call) => {
      const body = JSON.parse(String(call.init.body)) as {
        event: string;
        properties: Record<string, unknown>;
      };
      return body;
    });
    assert.ok(
      events.some(
        (event) =>
          event.event === "jarvis.operator_action" &&
          event.properties.outcome === "failure" &&
          event.properties.status_code === 401,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.event === "jarvis.runtime_failure" && event.properties.failure_kind === "http_4xx",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.event === "jarvis.runtime_failure" &&
          event.properties.failure_kind === "reconciliation_cycle_failed",
      ),
    );
  });

  it("returns before a slow telemetry endpoint resolves", async () => {
    const recorder = createFetchRecorder();
    let aborted = false;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      recorder.calls.push({ input: String(input), init });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    };
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), fetchImpl);

    const startedAt = Date.now();
    captureHttpBoundary(telemetry, {
      method: "GET",
      statusCode: 200,
      durationMs: 1,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 20);
    await telemetry.flush();
    assert.equal(aborted, true);
    // One HTTP boundary emits operator-action, latency, and usage events.
    assert.equal(recorder.calls.length, 3);
  });

  it("keeps the ten-second timeout out of ordinary request-path telemetry", () => {
    const recorder = createFetchRecorder();
    const runtimeTelemetry = createPostHogTelemetryFromEnv(
      developmentEnv({ POSTHOG_TIMEOUT_MS: "10000" }),
      recorder.fetchImpl,
    );
    const commissioningTelemetry = createPostHogCommissioningTelemetryFromEnv(
      developmentEnv({ POSTHOG_TIMEOUT_MS: "10000" }),
      recorder.fetchImpl,
    );

    assert.equal(runtimeTelemetry.enabled, false);
    assert.equal(commissioningTelemetry.enabled, true);
  });

  it("bounds stalled request-path telemetry and counts overflow as failed delivery", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    };
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), fetchImpl);

    for (let index = 0; index < 20; index += 1) {
      captureHttpBoundary(telemetry, { method: "GET", statusCode: 200, durationMs: 1 });
    }

    assert.equal(calls.length, 32);
    const receipt = await telemetry.flush();
    assert.deepEqual(receipt, { attempted: 60, accepted: 0, failed: 60 });
  });

  it("reports provider rejection instead of treating settlement as delivery", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 401, statusText: "Unauthorized" });
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), fetchImpl);

    captureHttpBoundary(telemetry, { method: "GET", statusCode: 200, durationMs: 1 });
    const receipt = await telemetry.flush();

    assert.deepEqual(receipt, { attempted: 3, accepted: 0, failed: 3 });
  });

  it("swallows telemetry transport failures without affecting the caller", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("synthetic telemetry failure");
    };
    const telemetry = createPostHogTelemetryFromEnv(developmentEnv(), fetchImpl);

    assert.doesNotThrow(() => {
      captureMcpBoundary(telemetry, {
        outcome: "success",
        durationMs: 4,
      });
    });
    const receipt = await telemetry.flush();
    assert.deepEqual(receipt, { attempted: 3, accepted: 0, failed: 3 });
  });
});
