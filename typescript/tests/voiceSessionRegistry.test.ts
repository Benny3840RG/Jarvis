import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { VoiceSessionRegistry } from "../src/voice/voiceSessionRegistry.js";

function registry(overrides: { ttlMs?: number; maxSessions?: number; now?: () => number } = {}) {
  const t = 0;
  return new VoiceSessionRegistry({
    provider: new AbsentHardwareProvider(),
    ttlMs: overrides.ttlMs ?? 1000,
    maxSessions: overrides.maxSessions ?? 100,
    clock: overrides.now ?? (() => t),
  });
}

describe("VoiceSessionRegistry", () => {
  it("creates an isolated session per call with a unique id", () => {
    const r = registry();
    const a = r.create("trailer");
    const b = r.create("workshop");
    assert.notEqual(a.id, b.id);
    assert.equal(r.get(a.id)?.profile, "trailer");
    assert.equal(r.get(b.id)?.profile, "workshop");
  });

  it("returns undefined for an unknown session id", () => {
    const r = registry();
    assert.equal(r.get("nope"), undefined);
  });

  it("evicts a session once its idle ttl lapses", () => {
    let now = 0;
    const r = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      ttlMs: 1000,
      clock: () => now,
    });
    const { id } = r.create("client");
    now = 1001;
    assert.equal(r.get(id), undefined, "expired session must not resolve");
    assert.equal(r.size(), 0, "expired session is dropped");
  });

  it("does not acknowledge an expired session as live when ending it", () => {
    let now = 0;
    const r = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      ttlMs: 1000,
      clock: () => now,
    });
    const { id } = r.create("client");
    now = 1001;
    assert.equal(r.end(id), false, "expired session must report not-found");
    assert.equal(r.size(), 0, "expired session is removed while checking end");
  });

  it("extends the ttl each time the session is touched", () => {
    let now = 0;
    const r = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      ttlMs: 1000,
      clock: () => now,
    });
    const { id } = r.create("client");
    now = 900;
    assert.ok(r.get(id), "still alive before ttl");
    now = 1800; // 900ms after the touch at 900
    assert.ok(r.get(id), "touch at 900 extended the ttl");
  });

  it("ends a session explicitly", () => {
    const r = registry();
    const { id } = r.create("crawler");
    assert.equal(r.end(id), true);
    assert.equal(r.get(id), undefined);
    assert.equal(r.end(id), false, "ending twice reports not-found");
  });

  it("bounds the number of live sessions, evicting the oldest", () => {
    let now = 0;
    const r = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      ttlMs: 1_000_000,
      maxSessions: 2,
      clock: () => now,
    });
    const first = r.create("crawler");
    now = 1;
    r.create("workshop");
    now = 2;
    r.create("trailer"); // exceeds max → oldest (first) evicted
    assert.equal(r.size(), 2);
    assert.equal(r.get(first.id), undefined, "oldest session was evicted");
  });
});
