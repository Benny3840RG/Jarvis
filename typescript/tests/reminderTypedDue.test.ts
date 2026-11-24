import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCreateReminder } from "../src/http/reminderRequest.js";

const ZONE = "Australia/Melbourne";

function due(text: string) {
  const parsed = parseCreateReminder({ title: "Call Dave", due: { text, timezone: ZONE } });
  assert.ok(parsed.due);
  return parsed.due;
}

function local(at: number) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: ZONE,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")}`;
}

describe("typed reminder times", () => {
  it("works out the everyday ways people type a time", () => {
    for (const [text, expected] of [
      ["friday at 9am", /^Friday 0?9:00$/],
      ["Friday 9am", /^Friday 0?9:00$/],
      ["tomorrow at 3 pm", /^\w+ 15:00$/],
      ["tonight at 7", /^\w+ 19:00$/],
      ["on monday at 8:30 am", /^Monday 0?8:30$/],
    ] as const) {
      const parsed = due(text);
      assert.equal(typeof parsed.at, "number", text);
      assert.match(local(parsed.at!), expected, text);
      assert.ok(parsed.at! > Date.now(), `${text} is in the future`);
      assert.equal(parsed.raw, text, "the typed words are kept");
    }
  });

  it("works out in N minutes, hours or days", () => {
    const before = Date.now();
    const parsed = due("in 2 hours");
    const after = Date.now();
    assert.ok(parsed.at! >= before + 2 * 3_600_000 && parsed.at! <= after + 2 * 3_600_000);
    assert.ok(due("in an hour").at! >= before + 3_600_000);
    assert.ok(due("in 30 minutes").at! >= before + 30 * 60_000);
  });

  it("keeps an ambiguous time as words and never guesses", () => {
    for (const text of ["next monday 8am", "at 7", "friday", "someday", "tonight at 12"]) {
      assert.equal(due(text).at, undefined, text);
    }
  });
});
