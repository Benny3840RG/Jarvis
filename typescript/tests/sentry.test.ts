import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSentryRuntime,
  type SentryEvent,
  type SentryTransport,
} from "../src/observability/sentry.js";

function transport(events: SentryEvent[]): SentryTransport {
  return {
    async send(event) {
      events.push(event);
    },
  };
}

describe("Sentry runtime adapter", () => {
  it("is inert when disabled", async () => {
    const events: SentryEvent[] = [];
    const runtime = createSentryRuntime(
      {
        enabled: false,
        release: "jarvis-test-release",
        environment: "test",
      },
      transport(events),
    );

    await runtime.captureError(new Error("failure must not be sent"), {
      operation: "http.request",
      route: "/api/v1/quotes",
    });
    await runtime.recordMeasurement({
      operation: "http.request",
      durationMs: 42,
      success: false,
    });

    assert.equal(runtime.enabled, false);
    assert.deepEqual(events, []);
  });

  it("emits redacted errors and stable measurements without request bodies", async () => {
    const events: SentryEvent[] = [];
    const runtime = createSentryRuntime(
      {
        enabled: true,
        release: "jarvis-release-123",
        environment: "development",
        secrets: ["service-secret"],
      },
      transport(events),
    );

    await runtime.captureError(
      new Error("failure service-secret john@example.com https://example.test/path?q=secret"),
      {
        operation: "http.request",
        route: "/api/v1/quotes/:quoteId",
        method: "POST",
        requestId: "request-123",
      },
    );
    await runtime.recordMeasurement({
      operation: "mcp.tool",
      durationMs: 123.5,
      success: true,
      tags: { route: "/api/v1/status" },
    });

    assert.equal(events.length, 2);
    const errorEvent = events[0]!;
    assert.equal(errorEvent.type, "error");
    assert.equal(errorEvent.release, "jarvis-release-123");
    assert.equal(errorEvent.environment, "development");
    assert.equal(errorEvent.tags.operation, "http.request");
    assert.equal(errorEvent.tags.route, "/api/v1/quotes/:quoteId");
    assert.equal(errorEvent.tags.request_id, "request-123");
    assert.match(errorEvent.exception?.values[0]?.value ?? "", /failure/);
    assert.doesNotMatch(JSON.stringify(errorEvent), /service-secret|john@example.com|https:\/\/example\/);
    assert.equal("request" in errorEvent, false);
    assert.equal("body" in errorEvent, false);

    const measurementEvent = events[1]!;
    assert.equal(measurementEvent.type, "transaction");
    assert.equal(measurementEvent.transaction, "mcp.tool");
    assert.equal(measurementEvent.measurements?.latency_ms?.value, 123.5);
    assert.equal(measurementEvent.tags.outcome, "success");
    assert.equal(measurementEvent.tags.route, "/api/v1/status");
    assert.equal(measurementEvent.release, "jarvis-release-123");
    assert.equal(measurementEvent.environment, "development");
  });

  it("rejects malformed configured DSNs before runtime activation", () => {
    assert.throws(
      () =>
        createSentryRuntime({
          enabled: true,
          dsn: "not-a-dsn",
          release: "jarvis-test-release",
          environment: "test",
        }),
      /SENTRY_DSN/,
    );
  });
});
