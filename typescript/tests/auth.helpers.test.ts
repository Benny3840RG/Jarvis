import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { requireOwner } from "../convex/authHelpers.js";

const originalCurrent = process.env.JARVIS_SERVICE_TOKEN;
const originalPrevious = process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;

// Tokens below must be at least 32 characters — requireOwner now rejects a
// shorter configured secret as a misconfiguration before it ever compares a
// candidate, so tests exercising the actual comparison logic need realistic,
// compliant token lengths rather than short human-readable placeholders.
const CURRENT_TOKEN = "current-token-0123456789abcdef01";
const NEW_TOKEN = "new-token-0123456789abcdef012345";
const OLD_TOKEN = "old-token-0123456789abcdef0123456";
const CURRENT_SECRET = "current-secret-0123456789abcdef0";
const PREVIOUS_SECRET = "previous-secret-0123456789abcdef";
const ORPHANED_PREVIOUS_TOKEN = "orphaned-old-token-0123456789abc";
const PREFIX_SHARED_TOKEN = "correct-horse-battery-staple-elephant";

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
    process.env.JARVIS_SERVICE_TOKEN = CURRENT_TOKEN;
    assert.equal(requireOwner(CURRENT_TOKEN), "jarvis-cli");
  });

  it("accepts the previous token during an overlap rotation", () => {
    process.env.JARVIS_SERVICE_TOKEN = NEW_TOKEN;
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = OLD_TOKEN;
    assert.equal(requireOwner(OLD_TOKEN), "jarvis-cli");
    assert.equal(requireOwner(NEW_TOKEN), "jarvis-cli");
  });

  it("revokes the previous token when the overlap variable is removed", () => {
    process.env.JARVIS_SERVICE_TOKEN = NEW_TOKEN;
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = OLD_TOKEN;
    assert.equal(requireOwner(OLD_TOKEN), "jarvis-cli");

    delete process.env.JARVIS_SERVICE_TOKEN_PREVIOUS;
    assert.throws(() => requireOwner(OLD_TOKEN), /Unauthorized/);
  });

  it("uses generic errors that do not expose supplied or configured tokens", () => {
    process.env.JARVIS_SERVICE_TOKEN = CURRENT_SECRET;
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = PREVIOUS_SECRET;

    let error: unknown;
    try {
      requireOwner("attacker-supplied-secret-0123456789");
    } catch (caught: unknown) {
      error = caught;
    }

    assert(error instanceof Error);
    assert.equal(error.message.includes(CURRENT_SECRET), false);
    assert.equal(error.message.includes(PREVIOUS_SECRET), false);
    assert.equal(error.message.includes("attacker-supplied-secret-0123456789"), false);
  });

  it("requires a current token even when a previous value exists", () => {
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = ORPHANED_PREVIOUS_TOKEN;
    assert.throws(() => requireOwner(ORPHANED_PREVIOUS_TOKEN), /Server misconfigured/);
  });

  it("rejects candidates that only share a prefix with the configured token", () => {
    process.env.JARVIS_SERVICE_TOKEN = PREFIX_SHARED_TOKEN;
    assert.throws(() => requireOwner(PREFIX_SHARED_TOKEN.slice(0, -1)), /Unauthorized/);
    assert.throws(() => requireOwner(`${PREFIX_SHARED_TOKEN}-extra`), /Unauthorized/);
    assert.throws(() => requireOwner("c"), /Unauthorized/);
    assert.equal(requireOwner(PREFIX_SHARED_TOKEN), "jarvis-cli");
  });

  it("rejects an empty candidate without matching an empty misconfiguration", () => {
    process.env.JARVIS_SERVICE_TOKEN = CURRENT_TOKEN;
    assert.throws(() => requireOwner(""), /Unauthorized/);
  });

  it("rejects a configured current token shorter than the minimum length", () => {
    process.env.JARVIS_SERVICE_TOKEN = "too-short";
    assert.throws(() => requireOwner("too-short"), /must be at least 32 characters/);
  });

  it("rejects a configured previous token shorter than the minimum length", () => {
    process.env.JARVIS_SERVICE_TOKEN = CURRENT_TOKEN;
    process.env.JARVIS_SERVICE_TOKEN_PREVIOUS = "too-short";
    assert.throws(() => requireOwner(CURRENT_TOKEN), /must be at least 32 characters/);
  });
});
