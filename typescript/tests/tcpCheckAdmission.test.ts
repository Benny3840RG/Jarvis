import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  admissionStatus,
  complete,
  DEFAULT_RATE_CONFIG,
  emptyAdmissionState,
  isSlotFree,
  markUncertain,
  recover,
  releaseReservation,
  reserve,
  resolve,
  start,
  startsInWindow,
  type AdmissionState,
  type RateConfig,
} from "../src/security/tcpCheck/index.js";

const EPOCH = 1;

describe("releaseReservation / markUncertain (attempt-scoped cleanup, Codex #2/#4)", () => {
  function reservedState(attemptId: string): { state: AdmissionState; fenceToken: number } {
    const r = reserve(emptyAdmissionState(), { attemptId, nowMs: 0, policyEpoch: EPOCH });
    assert.ok(r.outcome.ok);
    if (!r.outcome.ok) throw new Error("unreachable");
    return { state: r.state, fenceToken: r.outcome.fenceToken };
  }

  it("releaseReservation frees only this attempt's reserved slot", () => {
    const { state, fenceToken } = reservedState("A");
    // Wrong id or fence → not-held, slot untouched.
    assert.equal(releaseReservation(state, { attemptId: "B", fenceToken }).outcome.ok, false);
    assert.equal(
      releaseReservation(state, { attemptId: "A", fenceToken: fenceToken + 1 }).outcome.ok,
      false,
    );
    assert.notEqual(state.active, null);
    // Correct id+fence → released.
    const ok = releaseReservation(state, { attemptId: "A", fenceToken });
    assert.equal(ok.outcome.ok, true);
    assert.equal(ok.state.active, null);
  });

  it("releaseReservation will not release a started slot (phase-mismatch)", () => {
    const { state, fenceToken } = reservedState("A");
    const started = start(state, { attemptId: "A", fenceToken, nowMs: 0 }).state;
    const r = releaseReservation(started, { attemptId: "A", fenceToken });
    assert.equal(r.outcome.ok, false);
    if (!r.outcome.ok) assert.equal(r.outcome.reason, "phase-mismatch");
  });

  it("a stale A cannot release a later B's slot", () => {
    const { state: aReserved, fenceToken: fenceA } = reservedState("A");
    // A becomes stale via recovery (slot released, fence bumped), then B reserves.
    const afterRecover = recover(aReserved).state;
    const bReserved = reserve(afterRecover, { attemptId: "B", nowMs: 1, policyEpoch: EPOCH });
    assert.ok(bReserved.outcome.ok);
    // A's late cleanup must not touch B.
    const r = releaseReservation(bReserved.state, { attemptId: "A", fenceToken: fenceA });
    assert.equal(r.outcome.ok, false);
    assert.equal(r.state.active?.attemptId, "B");
  });

  it("markUncertain moves only this attempt's started slot to uncertain", () => {
    const { state, fenceToken } = reservedState("A");
    const started = start(state, { attemptId: "A", fenceToken, nowMs: 0 }).state;
    assert.equal(markUncertain(started, { attemptId: "B", fenceToken }).outcome.ok, false);
    const ok = markUncertain(started, { attemptId: "A", fenceToken });
    assert.equal(ok.outcome.ok, true);
    assert.equal(admissionStatus(ok.state), "blocked");
    // A later resolve releases it.
    assert.equal(resolve(ok.state, { attemptId: "A", signal: "socket-closed" }).outcome.ok, true);
  });
});

/** Reserve + start a fresh attempt, asserting each step succeeds. */
function admit(
  state: AdmissionState,
  attemptId: string,
  nowMs: number,
  config?: RateConfig,
): { state: AdmissionState; fenceToken: number } {
  const reserved = reserve(state, { attemptId, nowMs, policyEpoch: EPOCH, config });
  assert.equal(reserved.outcome.ok, true, "reserve should succeed");
  if (!reserved.outcome.ok) throw new Error("unreachable");
  const fenceToken = reserved.outcome.fenceToken;
  const started = start(reserved.state, { attemptId, fenceToken, nowMs });
  assert.equal(started.outcome.ok, true, "start should succeed");
  return { state: started.state, fenceToken };
}

describe("reserve", () => {
  it("grants the owner-wide slot once and refuses a second concurrent attempt", () => {
    const first = reserve(emptyAdmissionState(), { attemptId: "a", nowMs: 0, policyEpoch: EPOCH });
    assert.equal(first.outcome.ok, true);
    assert.equal(admissionStatus(first.state), "reserved");

    const second = reserve(first.state, { attemptId: "b", nowMs: 1, policyEpoch: EPOCH });
    assert.equal(second.outcome.ok, false);
    if (!second.outcome.ok) assert.equal(second.outcome.reason, "slot-busy");
  });

  it("the slot stays busy while an attempt is reserved, started, or uncertain", () => {
    const { state: active } = admit(emptyAdmissionState(), "a", 0);
    // started → still busy
    let blocked = reserve(active, { attemptId: "b", nowMs: 1, policyEpoch: EPOCH });
    assert.equal(blocked.outcome.ok, false);
    // move to uncertain via recovery → still busy (never reclaimed by a reserve)
    const recovered = recover(active);
    assert.equal(recovered.outcome.kind, "held-uncertain");
    blocked = reserve(recovered.state, { attemptId: "b", nowMs: 2, policyEpoch: EPOCH });
    assert.equal(blocked.outcome.ok, false);
    if (!blocked.outcome.ok) assert.equal(blocked.outcome.reason, "slot-busy");
  });

  it("fails closed on invalid input", () => {
    const s = emptyAdmissionState();
    assert.equal(reserve(s, { attemptId: "", nowMs: 0, policyEpoch: EPOCH }).outcome.ok, false);
    assert.equal(
      reserve(s, { attemptId: "a", nowMs: Number.NaN, policyEpoch: EPOCH }).outcome.ok,
      false,
    );
    assert.equal(reserve(s, { attemptId: "a", nowMs: 0, policyEpoch: 1.5 }).outcome.ok, false);
    assert.equal(
      reserve(s, {
        attemptId: "a",
        nowMs: 0,
        policyEpoch: EPOCH,
        config: { rateWindowMs: 0, maxStartsPerWindow: 10 },
      }).outcome.ok,
      false,
    );
  });

  it("issues a strictly increasing fence token across reservations", () => {
    const a = reserve(emptyAdmissionState(), { attemptId: "a", nowMs: 0, policyEpoch: EPOCH });
    assert.ok(a.outcome.ok && a.outcome.fenceToken === 1);
    const done = complete(start(a.state, { attemptId: "a", fenceToken: 1, nowMs: 0 }).state, {
      attemptId: "a",
      fenceToken: 1,
    });
    const b = reserve(done.state, { attemptId: "b", nowMs: 1, policyEpoch: EPOCH });
    assert.ok(b.outcome.ok && b.outcome.fenceToken > 1);
  });
});

describe("rate limit (never-refunded started history)", () => {
  const config: RateConfig = { rateWindowMs: 60_000, maxStartsPerWindow: 10 };

  it("denies the 11th start within the window even though each completed", () => {
    let state = emptyAdmissionState();
    for (let i = 0; i < 10; i += 1) {
      const admitted = admit(state, `a${i}`, 100 + i, config);
      // complete immediately — budget must NOT be refunded
      const done = complete(admitted.state, {
        attemptId: `a${i}`,
        fenceToken: admitted.fenceToken,
      });
      assert.equal(done.outcome.ok, true);
      state = done.state;
      assert.ok(isSlotFree(state), "slot free after complete");
    }
    assert.equal(startsInWindow(state, 200, config.rateWindowMs), 10);
    const eleventh = reserve(state, { attemptId: "a10", nowMs: 200, policyEpoch: EPOCH });
    assert.equal(eleventh.outcome.ok, false);
    if (!eleventh.outcome.ok) assert.equal(eleventh.outcome.reason, "rate-limited");
  });

  it("lets the window roll forward: old starts age out", () => {
    let state = emptyAdmissionState();
    for (let i = 0; i < 10; i += 1) {
      const admitted = admit(state, `a${i}`, 100 + i, config);
      state = complete(admitted.state, {
        attemptId: `a${i}`,
        fenceToken: admitted.fenceToken,
      }).state;
    }
    // 60s + 1ms past the last start → all aged out, a new reservation is allowed.
    const later = 109 + 60_000 + 1;
    assert.equal(startsInWindow(state, later, config.rateWindowMs), 0);
    const ok = reserve(state, { attemptId: "fresh", nowMs: later, policyEpoch: EPOCH });
    assert.equal(ok.outcome.ok, true);
  });

  it("a reservation that never starts does not consume rate budget", () => {
    const reserved = reserve(emptyAdmissionState(), {
      attemptId: "a",
      nowMs: 0,
      policyEpoch: EPOCH,
    });
    // release it as a stale reservation (no started write) → history untouched
    const released = recover({ ...reserved.state });
    assert.equal(released.outcome.kind, "released-stale-reservation");
    assert.equal(startsInWindow(released.state, 0, DEFAULT_RATE_CONFIG.rateWindowMs), 0);
  });
});

describe("start (fenced reserved → started)", () => {
  it("requires the live fence token and the reserved phase", () => {
    const reserved = reserve(emptyAdmissionState(), {
      attemptId: "a",
      nowMs: 0,
      policyEpoch: EPOCH,
    });
    assert.ok(reserved.outcome.ok);
    if (!reserved.outcome.ok) return;
    const token = reserved.outcome.fenceToken;

    assert.equal(
      start(reserved.state, { attemptId: "a", fenceToken: token + 99, nowMs: 1 }).outcome.ok,
      false,
    );
    assert.equal(
      start(reserved.state, { attemptId: "other", fenceToken: token, nowMs: 1 }).outcome.ok,
      false,
    );

    const started = start(reserved.state, { attemptId: "a", fenceToken: token, nowMs: 1 });
    assert.equal(started.outcome.ok, true);
    assert.equal(admissionStatus(started.state), "active");
    // starting twice is rejected (wrong-phase)
    const again = start(started.state, { attemptId: "a", fenceToken: token, nowMs: 2 });
    assert.equal(again.outcome.ok, false);
    if (!again.outcome.ok) assert.equal(again.outcome.reason, "wrong-phase");
  });
});

describe("complete (fence-conditional terminal)", () => {
  it("releases the slot but retains the never-refunded history entry", () => {
    const { state, fenceToken } = admit(emptyAdmissionState(), "a", 100);
    const done = complete(state, { attemptId: "a", fenceToken });
    assert.equal(done.outcome.ok, true);
    assert.ok(isSlotFree(done.state));
    assert.equal(startsInWindow(done.state, 100, DEFAULT_RATE_CONFIG.rateWindowMs), 1);
  });

  it("rejects a stale fence token (superseded straggler)", () => {
    const { state, fenceToken } = admit(emptyAdmissionState(), "a", 100);
    const bad = complete(state, { attemptId: "a", fenceToken: fenceToken + 1 });
    assert.equal(bad.outcome.ok, false);
    if (!bad.outcome.ok) assert.equal(bad.outcome.reason, "fence-mismatch");
  });
});

describe("recover (by durable phase)", () => {
  it("is idle when the slot is free", () => {
    const r = recover(emptyAdmissionState());
    assert.equal(r.outcome.kind, "idle");
  });

  it("releases a stale reservation (no connect was gated)", () => {
    const reserved = reserve(emptyAdmissionState(), {
      attemptId: "a",
      nowMs: 0,
      policyEpoch: EPOCH,
    });
    const r = recover(reserved.state);
    assert.equal(r.outcome.kind, "released-stale-reservation");
    assert.ok(isSlotFree(r.state));
  });

  it("holds a stale started as uncertain and never reclaims by time", () => {
    const { state } = admit(emptyAdmissionState(), "a", 0);
    const r = recover(state);
    assert.equal(r.outcome.kind, "held-uncertain");
    assert.equal(admissionStatus(r.state), "blocked");
    assert.equal(isSlotFree(r.state), false);
    // idempotent
    assert.equal(recover(r.state).outcome.kind, "already-uncertain");
  });

  it("supersedes the fence so a resumed straggler's late complete is rejected", () => {
    const { state, fenceToken } = admit(emptyAdmissionState(), "a", 0);
    const recovered = recover(state); // started → uncertain, fence bumped
    const straggler = complete(recovered.state, { attemptId: "a", fenceToken });
    assert.equal(straggler.outcome.ok, false);
    if (!straggler.outcome.ok) assert.equal(straggler.outcome.reason, "fence-mismatch");
  });
});

describe("resolve (uncertain → resolved, signal-driven only)", () => {
  it("releases the slot on an enforcer quiescence signal", () => {
    const { state } = admit(emptyAdmissionState(), "a", 0);
    const uncertain = recover(state).state;
    const resolved = resolve(uncertain, { attemptId: "a", signal: "socket-closed" });
    assert.equal(resolved.outcome.ok, true);
    assert.ok(isSlotFree(resolved.state));
    assert.equal(admissionStatus(resolved.state), "free");
  });

  it("refuses to resolve a slot that is not uncertain (no time-based exit)", () => {
    const { state } = admit(emptyAdmissionState(), "a", 0);
    // started, not yet recovered → cannot resolve
    const r = resolve(state, { attemptId: "a", signal: "never-admitted" });
    assert.equal(r.outcome.ok, false);
    if (!r.outcome.ok) assert.equal(r.outcome.reason, "not-uncertain");
  });

  it("refuses an unknown signal and an attempt-id mismatch", () => {
    const { state } = admit(emptyAdmissionState(), "a", 0);
    const uncertain = recover(state).state;
    assert.equal(
      // @ts-expect-error — invalid signal must be rejected at runtime too
      resolve(uncertain, { attemptId: "a", signal: "made-up" }).outcome.ok,
      false,
    );
    const mismatch = resolve(uncertain, { attemptId: "b", signal: "socket-closed" });
    assert.equal(mismatch.outcome.ok, false);
    if (!mismatch.outcome.ok) assert.equal(mismatch.outcome.reason, "attempt-mismatch");
  });

  it("frees the slot for the next check only after the signal arrives", () => {
    const { state } = admit(emptyAdmissionState(), "a", 0);
    const uncertain = recover(state).state;
    // blocked until resolved
    assert.equal(
      reserve(uncertain, { attemptId: "b", nowMs: 1, policyEpoch: EPOCH }).outcome.ok,
      false,
    );
    const resolved = resolve(uncertain, { attemptId: "a", signal: "never-admitted" }).state;
    assert.equal(
      reserve(resolved, { attemptId: "b", nowMs: 2, policyEpoch: EPOCH }).outcome.ok,
      true,
    );
  });
});
