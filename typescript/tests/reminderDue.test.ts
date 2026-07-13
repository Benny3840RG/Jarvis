import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseReminderDue,
  resolveReminderTimezone,
  validateReminderDue,
} from "../src/reminders/due.js";

describe("reminder due normalization", () => {
  it("preserves unparseable text without inventing a timestamp", () => {
    assert.deepEqual(parseReminderDue("after Claire calls", { timezone: "Australia/Melbourne" }), {
      raw: "after Claire calls",
    });
  });

  it("normalizes an absolute ISO timestamp and preserves the original text", () => {
    assert.deepEqual(parseReminderDue("2026-07-17T09:00:00+10:00"), {
      raw: "2026-07-17T09:00:00+10:00",
      at: Date.parse("2026-07-17T09:00:00+10:00"),
      timezone: "UTC+10:00",
    });
  });

  it("normalizes Australian local dates in an explicit IANA timezone", () => {
    assert.deepEqual(parseReminderDue("17/07/2026 9:30am", { timezone: "Australia/Melbourne" }), {
      raw: "17/07/2026 9:30am",
      at: Date.parse("2026-07-16T23:30:00.000Z"),
      timezone: "Australia/Melbourne",
    });
  });

  it("normalizes the next named weekday relative to the supplied current time", () => {
    assert.deepEqual(
      parseReminderDue("Friday 9am", {
        timezone: "Australia/Melbourne",
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
      {
        raw: "Friday 9am",
        at: Date.parse("2026-07-16T23:00:00.000Z"),
        timezone: "Australia/Melbourne",
      },
    );
  });

  it("rolls a named weekday forward when today's time has already passed", () => {
    assert.deepEqual(
      parseReminderDue("Monday 9am", {
        timezone: "Australia/Melbourne",
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
      {
        raw: "Monday 9am",
        at: Date.parse("2026-07-19T23:00:00.000Z"),
        timezone: "Australia/Melbourne",
      },
    );
  });

  it("does not normalize a wall-clock time that does not exist during a DST jump", () => {
    assert.deepEqual(parseReminderDue("04/10/2026 2:30am", { timezone: "Australia/Melbourne" }), {
      raw: "04/10/2026 2:30am",
    });
  });

  it("rejects invalid timezone configuration and inconsistent normalized values", () => {
    assert.throws(() => resolveReminderTimezone("Not/A-Timezone"), /Invalid JARVIS_TIMEZONE/);
    assert.throws(
      () => validateReminderDue({ raw: "Friday 9am", at: Date.now() }),
      /requires both a timestamp and timezone/,
    );
  });
});
