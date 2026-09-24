import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PersonalTraitsService } from "../src/runtime/personalTraitsService.js";

describe("PersonalTraitsService", () => {
  it("returns a non-empty daily brief", () => {
    const service = new PersonalTraitsService();
    const brief = service.dailyBrief();
    assert.equal(typeof brief, "string");
    assert.ok(brief.length > 0);
  });

  it("returns a non-empty motivation message", () => {
    const service = new PersonalTraitsService();
    const motivation = service.motivation();
    assert.equal(typeof motivation, "string");
    assert.ok(motivation.length > 0);
  });

  it("returns the same fixed text on every call", () => {
    const service = new PersonalTraitsService();
    assert.equal(service.dailyBrief(), service.dailyBrief());
    assert.equal(service.motivation(), service.motivation());
  });
});
