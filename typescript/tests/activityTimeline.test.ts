import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readActivityTimelinePage,
  type ActivityEventReader,
  type RawActivityEvent,
} from "../src/operations/activityTimeline.js";

function rawEvent(overrides: Partial<RawActivityEvent> = {}): RawActivityEvent {
  return {
    activityId: "event-1",
    eventType: "tool.action.proposed",
    actor: "agent",
    payload: { actionId: "action-1", tool: "clock", operation: "read" },
    createdAt: Date.parse("2026-07-30T12:00:00.000Z"),
    ...overrides,
  };
}

describe("readActivityTimelinePage", () => {
  it("translates a known event type into a safe, factual summary", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return { events: [rawEvent()], continueCursor: "cursor-1", isDone: true };
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.summary, "Tool action action-1 proposed (clock.read).");
    assert.equal(result.events[0]?.occurredAt, "2026-07-30T12:00:00.000Z");
    assert.equal(result.cursor, "cursor-1");
    assert.equal(result.isDone, true);
  });

  it("uses the source event's own timestamp, not render time", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return {
          events: [rawEvent({ createdAt: Date.parse("2020-01-01T00:00:00.000Z") })],
          continueCursor: "",
          isDone: true,
        };
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.events[0]?.occurredAt, "2020-01-01T00:00:00.000Z");
  });

  it("omits projectKey when the source event was recorded without one", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return {
          events: [rawEvent({ projectKey: undefined })],
          continueCursor: "",
          isDone: true,
        };
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal("projectKey" in result.events[0]!, false);
  });

  it("falls back to a type-only summary for an unrecognized event type, never exposing its payload", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return {
          events: [
            rawEvent({
              eventType: "some.future.event",
              payload: { secretLookingField: "should-never-appear" },
            }),
          ],
          continueCursor: "",
          isDone: true,
        };
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.events[0]?.summary, "some.future.event event.");
    assert.equal(JSON.stringify(result).includes("should-never-appear"), false);
  });

  it("never lets a rejection reason payload leak through JSON.stringify beyond the summary field", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return {
          events: [
            rawEvent({
              eventType: "tool.action.rejected",
              payload: { actionId: "action-2", reason: "duplicate request" },
            }),
          ],
          continueCursor: "",
          isDone: true,
        };
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.events[0]?.summary, "Tool action action-2 rejected: duplicate request.");
  });

  it("reports a read failure as unavailable with a reason, rather than an empty page", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        throw new Error("audit events store offline");
      },
    };
    const result = await readActivityTimelinePage({ reader, cursor: null, limit: 10 });
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.equal(result.reason, "audit events store offline");
  });

  it("passes the requested cursor and limit through to the reader unchanged", async () => {
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const reader: ActivityEventReader = {
      async listActivityPage(input) {
        calls.push(input);
        return { events: [], continueCursor: "next", isDone: false };
      },
    };
    await readActivityTimelinePage({ reader, cursor: "prev-cursor", limit: 25 });
    assert.deepEqual(calls, [{ cursor: "prev-cursor", limit: 25 }]);
  });
});
