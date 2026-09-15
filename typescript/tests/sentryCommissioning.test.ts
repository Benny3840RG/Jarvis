import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSentryCommissioning } from "../src/tools/runSentryCommissioning.js";

const sourceVersion = "a".repeat(40);
const environment = {
  JARVIS_ENVIRONMENT: "development",
  SENTRY_ENVIRONMENT: "development",
  SENTRY_DSN: "https://synthetic-key@example.invalid/123",
};

describe("Sentry commissioning", () => {
  it("rejects absent or production configuration before sending", async (t) => {
    let sends = 0;
    t.mock.method(globalThis, "fetch", async () => {
      sends += 1;
      return new Response(null, { status: 200 });
    });
    for (const invalid of [
      {},
      { ...environment, JARVIS_ENVIRONMENT: "production" },
      { ...environment, SENTRY_ENVIRONMENT: "production" },
      { ...environment, SENTRY_DSN: "" },
    ]) {
      await assert.rejects(runSentryCommissioning(invalid, sourceVersion));
    }
    await assert.rejects(runSentryCommissioning(environment, "development"));
    assert.equal(sends, 0);
  });

  it("exercises the real client and in-process app without claiming provider proof", async (t) => {
    const envelopes: string[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      envelopes.push(String(init.body));
      return new Response(null, { status: 200 });
    });
    const receipt = await runSentryCommissioning(environment, sourceVersion);
    assert.equal(receipt.sourceVersion, sourceVersion);
    assert.equal(receipt.statusCode, 503);
    assert.equal(receipt.providerEvidence, "NOT_PROVEN");
    assert.equal(receipt.alertEvidence, "NOT_PROVEN");
    assert.equal(envelopes.length, 2);
    assert.deepEqual(
      receipt.deliveries.map((item) => item.status),
      ["ACCEPTED", "ACCEPTED"],
    );
    const payloads = envelopes.map((envelope) => JSON.parse(envelope.trim().split("\n")[2]!));
    assert.deepEqual(
      receipt.deliveries.map((item) => item.eventId),
      payloads.map((item) => item.event_id),
    );
    for (const payload of payloads) {
      assert.equal(payload.release, sourceVersion);
      assert.equal(payload.environment, "development");
      assert.equal(payload.tags.operation, "mcp.tool");
      assert.equal(payload.tags.route, "/api/v1/status");
      assert.equal(payload.tags.status_code, "503");
      assert.equal("request" in payload, false);
      assert.equal("user" in payload, false);
    }
    assert.equal(payloads[1].contexts.trace.status, "internal_error");
    assert.ok(payloads[1].measurements.latency_ms.value >= 0);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /synthetic-key|example.invalid|Bearer|serviceToken/,
    );
  });

  it("preserves explicit rejection separately from an unknown transport outcome", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }));
    const rejected = await runSentryCommissioning(environment, sourceVersion);
    assert.deepEqual(
      rejected.deliveries.map((item) => item.status),
      ["REJECTED", "REJECTED"],
    );
    assert.ok(rejected.deliveries.every((item) => item.httpStatus === 429));
    assert.equal(rejected.providerEvidence, "NOT_PROVEN");
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("private transport detail");
    });
    const unknown = await runSentryCommissioning(environment, sourceVersion);
    assert.deepEqual(
      unknown.deliveries.map((item) => item.status),
      ["INDETERMINATE", "INDETERMINATE"],
    );
    assert.doesNotMatch(JSON.stringify(unknown), /private transport detail/);
  });

  it("associates deliveries with their event types when responses arrive out of order", async (t) => {
    let releaseError: () => void = () => {};
    const heldError = new Promise<void>((resolve) => {
      releaseError = resolve;
    });
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      const item = JSON.parse(String(init.body).split("\n")[1]!);
      if (item.type === "event") await heldError;
      else setImmediate(releaseError);
      return new Response(null, { status: item.type === "event" ? 429 : 200 });
    });
    const receipt = await runSentryCommissioning(environment, sourceVersion);
    assert.deepEqual(
      receipt.deliveries.map(({ eventType, status }) => ({ eventType, status })),
      [
        { eventType: "error", status: "REJECTED" },
        { eventType: "transaction", status: "ACCEPTED" },
      ],
    );
  });
});
