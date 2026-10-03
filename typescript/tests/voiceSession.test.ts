import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbsentHardwareProvider, type VoiceActuationProvider } from "../src/voice/voiceHardware.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

function session(provider: VoiceActuationProvider = new AbsentHardwareProvider()): VoiceSession {
  return new VoiceSession({
    profile: "trailer",
    provider,
    confirmationTtlMs: 10_000,
    historyLimit: 5,
  });
}

async function handle(
  s: VoiceSession,
  transcript: string,
  opts: { isFinal?: boolean; now: number; alternatives?: string[] },
) {
  return s.handle({
    transcript,
    isFinal: opts.isFinal ?? true,
    now: opts.now,
    alternatives: opts.alternatives,
  });
}

describe("voice session — dispatch and confirmation lifecycle", () => {
  it("answers a query directly without any governed or hardware effect", async () => {
    const s = new VoiceSession({ profile: "client", provider: new AbsentHardwareProvider() });
    const d = await s.handle({ transcript: "any unpaid invoices", isFinal: true, now: 0 });
    assert.equal(d.decision, "answer-query");
    if (d.decision === "answer-query") assert.equal(d.command.id, "client.unpaid-invoices");
  });

  it("only proposes a governed action — never approves or executes it", async () => {
    const s = new VoiceSession({ profile: "client", provider: new AbsentHardwareProvider() });
    const d = await s.handle({ transcript: "draft a quote", isFinal: true, now: 0 });
    assert.equal(d.decision, "proposed");
    if (d.decision === "proposed") {
      assert.equal(d.command.proposes?.operation, "quotes:draft");
    }
  });

  it("ignores interim transcripts entirely", async () => {
    const s = session();
    const d = await handle(s, "winch up", { isFinal: false, now: 0 });
    assert.equal(d.decision, "ignored-interim");
    assert.equal(s.pending(), undefined);
  });

  it("fails closed when actuation hardware is absent (no simulated acknowledgement)", async () => {
    const s = session();
    await handle(s, "trailer lights on", { now: 0 }); // routine actuate, no confirmation
    const d = await handle(s, "trailer lights on", { now: 1 });
    assert.equal(d.decision, "actuation-unavailable");
    if (d.decision === "actuation-unavailable") assert.equal(d.target, "trailer.lights");
  });

  it("arms a confirmation for a critical command and only acts after a spoken confirm", async () => {
    const s = session();
    const armed = await handle(s, "winch up", { now: 0 });
    assert.equal(armed.decision, "awaiting-confirmation");
    assert.ok(s.pending());

    const confirmed = await handle(s, "confirm", { now: 1_000 });
    // Hardware is absent, so the confirmed critical command fails closed.
    assert.equal(confirmed.decision, "actuation-unavailable");
    assert.equal(s.pending(), undefined, "confirmation must be consumed");
  });

  it("protects against replay: a second confirm after consumption does nothing", async () => {
    const s = session();
    await handle(s, "winch up", { now: 0 });
    await handle(s, "confirm", { now: 1_000 });
    const replay = await handle(s, "confirm", { now: 1_500 });
    assert.equal(replay.decision, "confirmation-not-pending");
  });

  it("expires a confirmation that is confirmed too late", async () => {
    const s = session();
    await handle(s, "winch up", { now: 0 });
    const late = await handle(s, "confirm", { now: 20_000 }); // past the 10s ttl
    assert.equal(late.decision, "confirmation-expired");
    assert.equal(s.pending(), undefined);
  });

  it("cancels a pending confirmation on a spoken cancel", async () => {
    const s = session();
    await handle(s, "deploy the ramp", { now: 0 });
    const cancelled = await handle(s, "cancel", { now: 100 });
    assert.equal(cancelled.decision, "cancelled");
    assert.equal(s.pending(), undefined);
  });

  it("invalidates a pending confirmation when the profile changes", async () => {
    const s = session();
    await handle(s, "winch up", { now: 0 });
    assert.ok(s.pending());
    s.setProfile("workshop", 1);
    assert.equal(s.pending(), undefined);
    assert.equal(s.profile, "workshop");
  });

  it("invalidates a pending confirmation on reset", async () => {
    const s = session();
    await handle(s, "winch up", { now: 0 });
    s.reset(1);
    assert.equal(s.pending(), undefined);
    assert.equal(s.history().length, 0);
  });

  it("invalidates a pending confirmation on a manual override", async () => {
    const s = session();
    await handle(s, "winch up", { now: 0 });
    s.manualOverride(1);
    assert.equal(s.pending(), undefined);
  });

  it("confirming with nothing armed is a no-op, not an action", async () => {
    const s = session();
    const d = await handle(s, "confirm", { now: 0 });
    assert.equal(d.decision, "confirmation-not-pending");
  });

  it("keeps sessions isolated — a confirm in one does not act on another's pending", async () => {
    const a = session();
    const b = session();
    await handle(a, "winch up", { now: 0 });
    const d = await handle(b, "confirm", { now: 1 });
    assert.equal(d.decision, "confirmation-not-pending");
    assert.ok(a.pending(), "session A keeps its own pending confirmation");
  });

  it("bounds the history ring buffer to the configured limit", async () => {
    const s = session();
    for (let i = 0; i < 12; i += 1) await handle(s, "trailer status", { now: i });
    assert.equal(s.history().length, 5);
  });

  it("actuates when a real adapter reports availability and acknowledges", async () => {
    const liveProvider: VoiceActuationProvider = {
      statusOf: () => "available",
      actuate: async ({ target }) => ({ status: "actuated", target }),
    };
    const s = new VoiceSession({ profile: "trailer", provider: liveProvider });
    const d = await s.handle({ transcript: "trailer lights on", isFinal: true, now: 0 });
    assert.equal(d.decision, "actuated");
  });
});

describe("AbsentHardwareProvider", () => {
  it("reports every target unavailable and never acknowledges actuation", async () => {
    const provider = new AbsentHardwareProvider();
    assert.equal(provider.statusOf("trailer.winch"), "unavailable");
    const result = await provider.actuate({
      target: "trailer.winch",
      commandId: "trailer.winch-up",
    });
    assert.equal(result.status, "unavailable");
  });
});
