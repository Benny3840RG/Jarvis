import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { requireOwner } from "../convex/authHelpers.js";

const originalCurrent = process.env.JARVIS_SERVICE_TOKEN;
const originalPrevious = process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;

beforeEach(() => {
  delete process.env.JARVIS_SERVICE_TOKEN;
  delete process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;
});

afterEach(() => {
  if (originalCurrent === undefined) delete process.env.JARVIS_SERVICE_TOKEN;
  else process.env.JARVIS_SERVICE_TOKEN = originalCurrent;

  if (originalPrevious === undefined) delete process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;
  else process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = originalPrevious;
});

describe("Jarvis service authentication", () => {
  it("accepts the current token", () => {
    process.env.JARVIS_SERVICE_TOKEN = "current-token";
    assert.equal(requireOwner("current-token"), "jarvis-cli");
  });

  it("accepts the previous token during an overlap rotation", () => {
    process.env.JARVIS_SERVICE_TOKEN = "new-token";
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = "old-token";
    assert.equal(requireOwner("old-token"), "jarvis-cli");
    assert.equal(requireOwner("new-token"), "jarvis-cli");
  });

  it("revokes the previous token when the overlap variable is removed", () => {
    process.env.JARVIS_SERVICE_TOKEN = "new-token";
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = "old-token";
    assert.equal(requireOwner("old-token"), "jarvis-cli");

    delete process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;
    assert.throws(() => requireOwner("old-token"), /Unauthorized/);
  });

  it("uses generic errors that do not expose supplied or configured tokens", () => {
    process.env.JARVIS_SERVICE_TOKEN = "current-secret";
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = "previous-secret";

    let error: unknown;
    try {
      requireOwner("attacker-supplied-secret");
    } catch (caught: unknown) {
      error = caught;
    }

    assert(error instanceof Error);
    assert.equal(error.message.includes("current-secret"), false);
    assert.equal(error.message.includes("previous-secret"), false);
    assert.equal(error.message.includes("attacker-supplied-secret"), false);
  });

  it("requires a current token even when a previous value exists", () => {
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = "orphaned-old-token";
    assert.throws(() => requireOwner("orphaned-old-token"), /Server misconfigured/);
  });

  it("rejects candidates that only share a prefix with the configured token", () => {
    process.env.JARVIS_SERVICE_TOKEN = "correct-horse-battery-staple";
    assert.throws(() => requireOwner("correct-horse-battery-stapl"), /Unauthorized/);
    assert.throws(() => requireOwner("correct-horse-battery-staple-extra"), /Unauthorized/);
    assert.throws(() => requireOwner("c"), /Unauthorized/);
    assert.equal(requireOwner("correct-horse-battery-staple"), "jarvis-cli");
  });

  it("rejects an empty candidate without matching an empty misconfiguration", () => {
    process.env.JARVIS_SERVICE_TOKEN = "current-token";
    assert.throws(() => requireOwner(""), /Unauthorized/);
  });
});
