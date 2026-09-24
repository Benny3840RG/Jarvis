import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  inspectReminderTimezone,
  parseReminderDue,
  resolveReminderTimezone,
} from "../src/reminders/due.js";

const ORIGINAL_TIMEZONE = process.env.JARVIS_TIMEZONE;

afterEach(() => {
  if (ORIGINAL_TIMEZONE === undefined) delete process.env.JARVIS_TIMEZONE;
  else process.env.JARVIS_TIMEZONE = ORIGINAL_TIMEZONE;
});

function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

describe("reminder timezone read model", () => {
  it("uses JARVIS_TIMEZONE as the effective zone and matches reminder normalization", () => {
    process.env.JARVIS_TIMEZONE = "Pacific/Auckland";
    const status = inspectReminderTimezone();

    assert.equal(status.valid, true);
    assert.equal(status.source, "env");
    assert.equal(status.envRaw, "Pacific/Auckland");
    assert.equal(status.effectiveIana, "Pacific/Auckland");
    assert.equal(status.validationError, undefined);
    assert.equal(resolveReminderTimezone(), status.effectiveIana);
    assert.equal(
      parseReminderDue("tomorrow 9am", {
        timezone: status.effectiveIana ?? undefined,
        now: new Date("2026-09-24T00:00:00.000Z"),
      }).timezone,
      status.effectiveIana,
    );
  });

  it("trims an env zone and still treats it as configured", () => {
    const status = inspectReminderTimezone("  Pacific/Auckland  ");

    assert.equal(status.source, "env");
    assert.equal(status.envRaw, "Pacific/Auckland");
    assert.equal(status.effectiveIana, resolveReminderTimezone("  Pacific/Auckland  "));
  });

  it("uses the machine zone when JARVIS_TIMEZONE is unset or blank", () => {
    delete process.env.JARVIS_TIMEZONE;
    const unset = inspectReminderTimezone();
    const blank = inspectReminderTimezone("   ");

    assert.equal(unset.source, "machine");
    assert.equal(unset.envRaw, null);
    assert.equal(unset.valid, true);
    assert.equal(unset.effectiveIana, machineZone());
    assert.equal(resolveReminderTimezone(), unset.effectiveIana);
    assert.deepEqual(blank, { ...unset, machineIana: unset.machineIana });
    assert.notEqual(blank.effectiveIana, null);
  });

  it("fail-closes an invalid env zone without applying the machine default", () => {
    process.env.JARVIS_TIMEZONE = "Not/A-Timezone";
    const status = inspectReminderTimezone();

    assert.equal(status.valid, false);
    assert.equal(status.source, "env");
    assert.equal(status.envRaw, "Not/A-Timezone");
    assert.equal(status.effectiveIana, null);
    assert.equal(status.machineIana, machineZone());
    assert.notEqual(status.machineIana, status.envRaw);
    assert.match(status.validationError ?? "", /Invalid JARVIS_TIMEZONE/);
    assert.throws(() => resolveReminderTimezone(), /Invalid JARVIS_TIMEZONE/);
    assert.throws(
      () => parseReminderDue("tomorrow 9am", { timezone: "Not/A-Timezone" }),
      /Invalid JARVIS_TIMEZONE/,
    );
  });

  it("does not echo an oversized or unsafe env value", () => {
    const status = inspectReminderTimezone(`Not/A-Timezone\nsecret`);

    assert.equal(status.valid, false);
    assert.equal(status.effectiveIana, null);
    assert.equal(status.envRaw, null);
    assert.equal(status.validationError, "JARVIS_TIMEZONE is not a valid IANA timezone.");
    assert.equal(JSON.stringify(status).includes("secret"), false);
  });
});
