// Phase 5 + Codex repairs — the adversarial acceptance suite (design §Tests and
// the review findings), over the composed stack (admission + egress mediator +
// governed provider) with in-memory fakes. No network, no node:net.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  complete,
  computeAllowlistDigest,
  emptyAdmissionState,
  emptyLedger,
  beginConsume,
  finalizeConsume,
  recover,
  reserve,
  resolve,
  start,
  startsInWindow,
  createInMemoryAdmissionStore,
  createTcpCheckProvider,
  RATE_WINDOW_MS,
  type AdmissionState,
  type AdmissionStore,
  type Allowlist,
  type ConnectOutcome,
  type LedgerPort,
  type PolicyView,
  type SettledOutcome,
  type SingleUseLedger,
} from "../src/security/tcpCheck/index.js";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const ALLOWLIST: Allowlist = { entries: [{ ip: "8.8.8.8", ports: [443] }] };

function makePolicy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    allowlist: ALLOWLIST,
    snapshotDate: "2026-11-09T00:00:00Z",
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 1,
    ...overrides,
  };
}

function inMemoryLedgerPort(): LedgerPort & { ledger: SingleUseLedger } {
  const port = {
    ledger: emptyLedger(),
    begin: (claimKey: string, nowMs: number) => {
      const r = beginConsume(port.ledger, { claimKey, nowMs });
      if (r.kind === "fresh") port.ledger = r.ledger;
      return r;
    },
    finalize: (claimKey: string, outcome: SettledOutcome, nowMs: number): void => {
      port.ledger = finalizeConsume(port.ledger, { claimKey, outcome, nowMs }).ledger;
    },
  };
  return port;
}

interface World {
  setPolicy(p: PolicyView): void;
  setNow(ms: number): void;
  setFenceActive(active: boolean): void;
  setOutcome(o: ConnectOutcome): void;
  connectCalls(): number;
  admission: AdmissionStore & { snapshot(owner: string): AdmissionState };
  provider: ReturnType<typeof createTcpCheckProvider>;
  run(
    ip: string,
    port: number,
    fingerprint: string,
  ): Promise<{
    status: string;
    target: string;
    allowlistDigest: string;
    admissionSignal: string | null;
  }>;
}

function makeWorld(opts: { deadlineMs?: number; leaseMs?: number } = {}): World {
  let policy = makePolicy();
  let now = NOW;
  let fenceActive = true;
  let outcome: ConnectOutcome = "connected";
  let connects = 0;
  const admission = createInMemoryAdmissionStore();

  const provider = createTcpCheckProvider({
    policy: () => policy,
    admission,
    fence: { isActive: () => fenceActive },
    ledger: inMemoryLedgerPort(),
    clock: () => now,
    connector: {
      async connect(): Promise<ConnectOutcome> {
        connects += 1;
        return outcome;
      },
    },
    ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.leaseMs ? { leaseMs: opts.leaseMs } : {}),
  });

  return {
    setPolicy: (p) => {
      policy = p;
    },
    setNow: (ms) => {
      now = ms;
    },
    setFenceActive: (a) => {
      fenceActive = a;
    },
    setOutcome: (o) => {
      outcome = o;
    },
    connectCalls: () => connects,
    admission,
    provider,
    async run(ip, port, fingerprint) {
      const attempt = await provider.prepare(
        { ip, port },
        { owner: "owner-1", project: "proj-1", actionFingerprint: fingerprint, correlationId: "c" },
      );
      return provider.sendPrepared(attempt);
    },
  };
}

describe("acceptance — effect outcomes and single-use", () => {
  it("a check runs to a terminal outcome, releases the slot, and yields a digest-only receipt", async () => {
    const w = makeWorld();
    const r = await w.run("8.8.8.8", 443, "fp-1");
    assert.equal(r.status, "connected");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(r.target, "8.8.8.8:443");
    assert.equal(r.allowlistDigest, computeAllowlistDigest(ALLOWLIST));
    assert.deepEqual(Object.keys(r).sort(), [
      "admissionSignal",
      "allowlistDigest",
      "status",
      "target",
    ]);
    assert.equal(w.admission.snapshot("owner-1").active, null);
  });

  it("a recorded timeout is distinct from an unknown effect", async () => {
    const w = makeWorld();
    w.setOutcome("timed-out");
    const r = await w.run("8.8.8.8", 443, "fp-t");
    assert.equal(r.status, "timed-out");
    assert.equal(r.admissionSignal, "socket-closed");
  });

  it("a refused connection is distinct from a transport error (Codex taxonomy)", async () => {
    const w1 = makeWorld();
    w1.setOutcome("refused");
    assert.equal((await w1.run("8.8.8.8", 443, "fp-r")).status, "refused");
    const w2 = makeWorld();
    w2.setOutcome("error");
    assert.equal((await w2.run("8.8.8.8", 443, "fp-e")).status, "error");
  });

  it("a completed-result replay opens no socket and returns the stored outcome", async () => {
    const w = makeWorld();
    w.setOutcome("refused");
    const first = await w.run("8.8.8.8", 443, "fp-dup");
    assert.equal(first.status, "refused");
    assert.equal(w.connectCalls(), 1);
    const replay = await w.run("8.8.8.8", 443, "fp-dup");
    assert.equal(replay.status, "replayed");
    assert.equal(w.connectCalls(), 1, "no second connect");
    assert.equal(
      w.admission.snapshot("owner-1").active,
      null,
      "replay still releases its own slot",
    );
  });

  it("the not-commissioned default connector holds the slot as uncertain (no phantom success)", async () => {
    const admission = createInMemoryAdmissionStore();
    const provider = createTcpCheckProvider({
      policy: () => makePolicy(),
      admission,
      fence: { isActive: () => true },
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      // no connector -> notCommissionedConnector (throws)
    });
    const attempt = await provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp-nc", correlationId: "c" },
    );
    const r = await provider.sendPrepared(attempt);
    assert.equal(r.status, "effect_uncertain");
    assert.equal(r.admissionSignal, null);
    assert.notEqual(admission.snapshot("owner-1").active, null);
  });
});

describe("acceptance — Codex #1 atomic admission under concurrency", () => {
  it("two simultaneous prepares admit exactly one; the other is slot-busy, no lost history", async () => {
    const w = makeWorld();
    const results = await Promise.allSettled([
      w.provider.prepare(
        { ip: "8.8.8.8", port: 443 },
        { owner: "owner-1", project: "proj-1", actionFingerprint: "fp-a", correlationId: "c" },
      ),
      w.provider.prepare(
        { ip: "8.8.8.8", port: 443 },
        { owner: "owner-1", project: "proj-1", actionFingerprint: "fp-b", correlationId: "c" },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one winner");
    assert.equal(rejected.length, 1, "the other is refused");
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /slot-busy/);
    // Exactly one reservation holds the single owner-wide slot.
    assert.notEqual(w.admission.snapshot("owner-1").active, null);
  });
});

describe("acceptance — admission limits", () => {
  it("the eleventh fast check within 60 s is rate-limited, and window roll-over resumes", async () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await w.run("8.8.8.8", 443, `fp-${i}`)).status, "connected");
    }
    await assert.rejects(w.run("8.8.8.8", 443, "fp-11"), /rate-limited/);
    w.setNow(NOW + RATE_WINDOW_MS + 1);
    assert.equal((await w.run("8.8.8.8", 443, "fp-after")).status, "connected");
  });

  it("a rejected target consumes no rate budget (Codex #9)", async () => {
    const w = makeWorld();
    // 10 good checks fill the window.
    for (let i = 0; i < 10; i += 1) await w.run("8.8.8.8", 443, `fp-${i}`);
    // A not-permitted target is refused at prepare and must not count.
    await assert.rejects(w.run("9.9.9.9", 443, "fp-bad"), /not permitted/);
    assert.equal(startsInWindow(w.admission.snapshot("owner-1"), NOW, RATE_WINDOW_MS), 10);
  });
});

describe("acceptance — policy freshness, narrowing, and expiry at the gate", () => {
  it("a target narrowed out of the policy before the effect opens no socket (policy_changed)", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setPolicy(makePolicy({ allowlist: { entries: [{ ip: "1.1.1.1", ports: [443] }] } }));
    const r = await w.provider.sendPrepared(attempt);
    assert.equal(r.status, "policy_changed");
    assert.equal(r.admissionSignal, "never-admitted");
    assert.equal(w.connectCalls(), 0);
    assert.equal(w.admission.snapshot("owner-1").active, null);
    // The narrowed attempt never started -> consumed no budget.
    assert.equal(startsInWindow(w.admission.snapshot("owner-1"), NOW, RATE_WINDOW_MS), 0);
  });

  it("a reservation that pauses past the freshness bound is refused (policy_changed)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const w = makeWorld({ leaseMs: 400 * day });
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setNow(NOW + 200 * day);
    assert.equal((await w.provider.sendPrepared(attempt)).status, "policy_changed");
    assert.equal(w.connectCalls(), 0);
  });

  it("a capability resumed past its lease is refused (expired), opens no socket", async () => {
    const w = makeWorld({ leaseMs: 15_000 });
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setNow(NOW + 20_000);
    assert.equal((await w.provider.sendPrepared(attempt)).status, "expired");
    assert.equal(w.connectCalls(), 0);
  });

  it("a policy epoch advanced under the claim is refused (policy_changed)", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setPolicy(makePolicy({ policyEpoch: 2 }));
    assert.equal((await w.provider.sendPrepared(attempt)).status, "policy_changed");
    assert.equal(w.connectCalls(), 0);
  });

  it("a superseded fence is refused (fence_superseded), opens no socket", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setFenceActive(false);
    assert.equal((await w.provider.sendPrepared(attempt)).status, "fence_superseded");
    assert.equal(w.connectCalls(), 0);
  });
});

describe("acceptance — Codex #8 receipt binding and default-deny", () => {
  it("the receipt digest is the approved digest from the claim, not a post-effect policy read", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "owner-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    const approved = attempt.claim.approvedAllowlistDigest;
    // Change the active policy's digest-bearing content AFTER prepare: the gate
    // will refuse, but the receipt still reports the approved (claim) digest.
    w.setPolicy(makePolicy({ allowlist: { entries: [{ ip: "8.8.8.8", ports: [443, 53] }] } }));
    const r = await w.provider.sendPrepared(attempt);
    assert.equal(r.status, "policy_changed");
    assert.equal(r.allowlistDigest, approved);
    assert.notEqual(
      approved,
      computeAllowlistDigest({ entries: [{ ip: "8.8.8.8", ports: [443, 53] }] }),
    );
  });

  it("an empty allowlist is default-deny: every target is refused before reserving", async () => {
    const w = makeWorld();
    w.setPolicy(makePolicy({ allowlist: { entries: [] } }));
    await assert.rejects(w.run("8.8.8.8", 443, "fp"), /not permitted/);
    assert.equal(w.connectCalls(), 0);
    assert.equal(w.admission.snapshot("owner-1").active, null);
  });
});

describe("acceptance — crash recovery (never a second executor, never an invented result)", () => {
  function startedAttempt(): { state: AdmissionState; attemptId: string; fenceToken: number } {
    const attemptId = "att-1";
    const reserved = reserve(emptyAdmissionState(), { attemptId, nowMs: NOW, policyEpoch: 1 });
    assert.ok(reserved.outcome.ok);
    if (!reserved.outcome.ok) throw new Error("unreachable");
    const fenceToken = reserved.outcome.fenceToken;
    const started = start(reserved.state, { attemptId, fenceToken, nowMs: NOW });
    return { state: started.state, attemptId, fenceToken };
  }

  it("crash after started holds the slot as blocked, no new admission is possible", () => {
    const { state } = startedAttempt();
    const recovered = recover(state);
    assert.equal(recovered.outcome.kind, "held-uncertain");
    assert.equal(
      reserve(recovered.state, { attemptId: "att-2", nowMs: NOW + 1, policyEpoch: 1 }).outcome.ok,
      false,
    );
  });

  it("a resumed straggler cannot commit a late terminal (result-commit fence)", () => {
    const { state, attemptId, fenceToken } = startedAttempt();
    const recovered = recover(state);
    assert.equal(complete(recovered.state, { attemptId, fenceToken }).outcome.ok, false);
  });

  it("an uncertain attempt resolves only on an enforcer signal, then readmits", () => {
    const { state, attemptId } = startedAttempt();
    const uncertain = recover(state).state;
    assert.equal(recover(uncertain).outcome.kind, "already-uncertain");
    assert.equal(
      reserve(uncertain, { attemptId: "att-2", nowMs: NOW + 1, policyEpoch: 1 }).outcome.ok,
      false,
    );
    const resolved = resolve(uncertain, { attemptId, signal: "socket-closed" });
    assert.equal(resolved.outcome.ok, true);
    assert.equal(
      reserve(resolved.state, { attemptId: "att-2", nowMs: NOW + 2, policyEpoch: 1 }).outcome.ok,
      true,
    );
  });

  it("a stale reserved (never-started) releases via fenced cleanup and consumes no budget", () => {
    const reserved = reserve(emptyAdmissionState(), {
      attemptId: "att-1",
      nowMs: NOW,
      policyEpoch: 1,
    });
    const recovered = recover(reserved.state);
    assert.equal(recovered.outcome.kind, "released-stale-reservation");
    assert.equal(startsInWindow(recovered.state, NOW, RATE_WINDOW_MS), 0);
  });
});
