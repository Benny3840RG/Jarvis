import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexRuntimeEventSink } from "../src/persistence/convexRuntimeEvents.js";

describe("ConvexRuntimeEventSink", () => {
  it("appends only the allowlisted metadata projection", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        throw new Error("must not be called");
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return {};
      },
    } as unknown as ConvexClientLike;
    const sink = new ConvexRuntimeEventSink(client, "service-token");

    await sink.append({
      version: 1,
      sequence: 4,
      id: "runtime-event-4",
      type: "runtime.route.failed",
      occurredAt: "2026-08-06T12:00:00.000Z",
      correlationId: "corr-4",
      payload: {
        route: "notes:create",
        errorCode: "handler-failed",
        secret: "must-not-persist",
        nested: { password: "must-not-persist" },
      },
    });

    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      eventId: "runtime-event-4",
      sequence: 4,
      eventType: "runtime.route.failed",
      correlationId: "corr-4",
      route: "notes:create",
      metadata: { route: "notes:create", errorCode: "handler-failed" },
      occurredAt: 1786017600000,
    });
  });

  it("requires a service token", () => {
    assert.throws(
      () => new ConvexRuntimeEventSink({} as ConvexClientLike, undefined),
      /JARVIS_SERVICE_TOKEN/,
    );
  });
});
