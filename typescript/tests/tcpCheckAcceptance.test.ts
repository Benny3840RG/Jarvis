// Phase 5 — the adversarial acceptance suite (design §Tests). Each case maps a
// named scenario from docs/design/issue-732-stage3-authorised-diagnostics.md to
// an assertion over the *composed* stack (admission + egress mediator + governed
// provider), using in-memory fakes. No network, no node:net.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  complete,
  computeAllowlistDigest,
  emptyAdmissionState,
  emptyLedger,
  beginConsume,
  finalizeConsume,
  parseCanonicalAddress,
  recover,
  reserve,
  resolve,
  start,
  startsInWindow,
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
    snapshotDate: "2026-11-07T00:00:00Z",
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 1,
    ...overrides,
  };
}

interface World {
  setPolicy(p: PolicyView): void;
  setNow(ms: number): void;
  setFenceActive(active: boolean): void;
  setOutcome(o: ConnectOutcome): void;
  connectCalls(): number;
  admissionState(): AdmissionState;
  setAdmissionState(s: AdmissionState): void;
  provider: ReturnType<typeof createTcpCheckProvider>;
  /** Full governed flow for one target; returns the digest-only summary. */
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
  let outcome: ConnectOutcome = "completed";
  let connects = 0;

  const admissionBacking = { state: emptyAdmissionState() };
  const admission: AdmissionStore = {
    get: () => admissionBacking.state,
    put: (_owner, next) => {
      admissionBacking.state = next;
    },
  };

  const ledgerBacking: { ledger: SingleUseLedger } = { ledger: emptyLedger() };
  const ledger: LedgerPort = {
    begin: (claimKey, nowMs) => {
      const r = beginConsume(ledgerBacking.ledger, { claimKey, nowMs });
      if (r.kind === "fresh") ledgerBacking.ledger = r.ledger;
      return r;
    },
    finalize: (claimKey, settled: SettledOutcome, nowMs) => {
      ledgerBacking.ledger = finalizeConsume(ledgerBacking.ledger, {
        claimKey,
        outcome: settled,
        nowMs,
      }).ledger;
    },
  };

  const provider = createTcpCheckProvider({
    policy: () => policy,
    admission,
    fence: { isActive: () => fenceActive },
    ledger,
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
    admissionState: () => admissionBacking.state,
    setAdmissionState: (s) => {
      admissionBacking.state = s;
    },
    provider,
    async run(ip, port, fingerprint) {
      const attempt = await provider.prepare(
        { ip, port },
        { owner: "proj-1", project: "proj-1", actionFingerprint: fingerprint, correlationId: "c" },
      );
      return provider.sendPrepared(attempt, { ip, port });
    },
  };
}

describe("acceptance — effect outcomes and single-use", () => {
  it("a check runs to a terminal outcome, releases the slot, and yields a digest-only receipt", async () => {
    const w = makeWorld();
    const r = await w.run("8.8.8.8", 443, "fp-1");
    assert.equal(r.status, "completed");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(r.target, "8.8.8.8:443");
    assert.equal(r.allowlistDigest, computeAllowlistDigest(ALLOWLIST));
    assert.deepEqual(Object.keys(r).sort(), [
      "admissionSignal",
      "allowlistDigest",
      "status",
      "target",
    ]);
    assert.equal(w.admissionState().active, null); // slot released
  });

  it("a recorded timeout is distinct from an unknown effect", async () => {
    const w = makeWorld();
    w.setOutcome("timed-out");
    const r = await w.run("8.8.8.8", 443, "fp-t");
    assert.equal(r.status, "timed-out");
    assert.equal(r.admissionSignal, "socket-closed"); // recorded, not unknown
  });

  it("cancellation mid-connect releases the slot but keeps the rate-history entry", async () => {
    const w = makeWorld();
    w.setOutcome("cancelled");
    const r = await w.run("8.8.8.8", 443, "fp-c");
    assert.equal(r.status, "cancelled");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(w.admissionState().active, null);
    assert.equal(startsInWindow(w.admissionState(), NOW, RATE_WINDOW_MS), 1); // not refunded
  });

  it("a completed-result replay opens no socket and returns the stored outcome", async () => {
    const w = makeWorld();
    w.setOutcome("failed");
    const first = await w.run("8.8.8.8", 443, "fp-dup");
    assert.equal(first.status, "failed");
    assert.equal(w.connectCalls(), 1);

    // Duplicate delivery of the same approved action reaches the mediator again.
    const replay = await w.run("8.8.8.8", 443, "fp-dup");
    assert.equal(replay.status, "replayed");
    assert.equal(w.connectCalls(), 1, "no second connect");
    assert.equal(w.admissionState().active, null, "replay still releases its own slot");
  });

  it("the not-commissioned default connector yields an uncertain effect and holds the slot", async () => {
    const w = makeWorld();
    // Force the not-commissioned path by throwing from the connector.
    const provider = createTcpCheckProvider({
      policy: () => makePolicy(),
      admission: { get: () => w.admissionState(), put: (_o, s) => w.setAdmissionState(s) },
      fence: { isActive: () => true },
      ledger: {
        begin: (k, n) => beginConsume(emptyLedger(), { claimKey: k, nowMs: n }),
        finalize: () => {},
      },
      clock: () => NOW,
      // no connector -> notCommissionedConnector (throws)
    });
    const attempt = await provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp-nc", correlationId: "c" },
    );
    const r = await provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "effect_uncertain");
    assert.equal(r.admissionSignal, null);
    assert.notEqual(w.admissionState().active, null); // slot held, no phantom success
  });
});

describe("acceptance — admission limits", () => {
  it("the eleventh fast check within 60 s is rate-limited, and window roll-over resumes admission", async () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i += 1) {
      const r = await w.run("8.8.8.8", 443, `fp-${i}`);
      assert.equal(r.status, "completed");
    }
    await assert.rejects(w.run("8.8.8.8", 443, "fp-11"), /rate-limited/);

    w.setNow(NOW + RATE_WINDOW_MS + 1); // roll the window forward
    const after = await w.run("8.8.8.8", 443, "fp-after");
    assert.equal(after.status, "completed");
  });

  it("at the concurrency limit, exactly one attempt is admitted", async () => {
    const w = makeWorld();
    await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp-a", correlationId: "c" },
    );
    await assert.rejects(
      w.provider.prepare(
        { ip: "8.8.8.8", port: 443 },
        { owner: "proj-1", project: "proj-1", actionFingerprint: "fp-b", correlationId: "c" },
      ),
      /slot-busy/,
    );
  });
});

describe("acceptance — policy freshness, narrowing, and expiry at the egress gate", () => {
  it("a target narrowed out of the policy before the effect opens no socket (policy_changed)", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setPolicy(makePolicy({ allowlist: { entries: [{ ip: "1.1.1.1", ports: [443] }] } }));
    const r = await w.provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "policy_changed");
    assert.equal(r.admissionSignal, "never-admitted");
    assert.equal(w.connectCalls(), 0);
    assert.equal(w.admissionState().active, null); // never-admitted releases the slot
  });

  it("a reservation that pauses past the freshness bound is refused (policy_changed), unchanged digest/epoch", async () => {
    const day = 24 * 60 * 60 * 1000;
    // A lease long enough that the expiry check does not fire first, so the
    // refusal is attributable to freshness (table age > maxAge), not expiry.
    const w = makeWorld({ leaseMs: 400 * day });
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setNow(NOW + 200 * day); // table age (~213 d) now exceeds the 90 d maxAge
    const r = await w.provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "policy_changed");
    assert.equal(w.connectCalls(), 0);
  });

  it("a capability resumed past its lease is refused (expired), opens no socket", async () => {
    const w = makeWorld({ leaseMs: 15_000 });
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setNow(NOW + 20_000); // past the 15 s lease
    const r = await w.provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "expired");
    assert.equal(w.connectCalls(), 0);
  });

  it("a policy epoch advanced under the claim is refused (policy_changed)", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setPolicy(makePolicy({ policyEpoch: 2 }));
    const r = await w.provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "policy_changed");
    assert.equal(w.connectCalls(), 0);
  });

  it("a superseded fence is refused at the gate (fence_superseded), opens no socket", async () => {
    const w = makeWorld();
    const attempt = await w.provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
    );
    w.setFenceActive(false);
    const r = await w.provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(r.status, "fence_superseded");
    assert.equal(w.connectCalls(), 0);
  });
});

describe("acceptance — digest integrity, redaction, and default-deny", () => {
  it("the allowlist digest is server-computed and content-bound (a row edit changes it)", async () => {
    const w = makeWorld();
    const r = await w.run("8.8.8.8", 443, "fp");
    assert.equal(r.allowlistDigest, computeAllowlistDigest(ALLOWLIST));
    assert.notEqual(
      computeAllowlistDigest(ALLOWLIST),
      computeAllowlistDigest({ entries: [{ ip: "8.8.8.8", ports: [443, 53] }] }),
    );
  });

  it("an empty allowlist is default-deny: every target is refused before reserving", async () => {
    const w = makeWorld();
    w.setPolicy(makePolicy({ allowlist: { entries: [] } }));
    await assert.rejects(w.run("8.8.8.8", 443, "fp"), /not permitted/);
    assert.equal(w.connectCalls(), 0);
    assert.equal(w.admissionState().active, null); // nothing reserved
  });
});

describe("acceptance — crash recovery (never a second executor, never an invented result)", () => {
  function startedAttempt(): {
    state: AdmissionState;
    attemptId: string;
    fenceToken: number;
  } {
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

  it("a resumed straggler cannot commit a late completed (result-commit fence)", () => {
    const { state, attemptId, fenceToken } = startedAttempt();
    const recovered = recover(state); // started -> uncertain, fence bumped
    const straggler = complete(recovered.state, { attemptId, fenceToken });
    assert.equal(straggler.outcome.ok, false);
  });

  it("an uncertain attempt resolves only on an enforcer signal, then readmits", () => {
    const { state, attemptId } = startedAttempt();
    const uncertain = recover(state).state;
    // repeated recoveries never accumulate a second executor
    assert.equal(recover(uncertain).outcome.kind, "already-uncertain");
    assert.equal(
      reserve(uncertain, { attemptId: "att-2", nowMs: NOW + 1, policyEpoch: 1 }).outcome.ok,
      false,
    );
    // resolve on the enforcer's durable signal releases the slot
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
    // a resumed stale-token worker cannot then start
    assert.ok(reserved.outcome.ok);
    if (!reserved.outcome.ok) return;
    assert.equal(
      start(recovered.state, {
        attemptId: "att-1",
        fenceToken: reserved.outcome.fenceToken,
        nowMs: NOW + 1,
      }).outcome.ok,
      false,
    );
  });
});

describe("acceptance — canonicalisation and special-use are enforced before any effect", () => {
  it("non-canonical, special-use, and off-allowlist targets are all refused with no socket", async () => {
    for (const [ip, port] of [
      ["08.8.8.8", 443], // non-canonical
      ["127.0.0.1", 443], // special-use
      ["9.9.9.9", 443], // not allowlisted
      ["8.8.8.8", 80], // port not allowlisted
    ] as const) {
      const w = makeWorld();
      await assert.rejects(w.run(ip, port, "fp"));
      assert.equal(w.connectCalls(), 0);
    }
    // sanity: the canonical form of each special-use literal still parses
    assert.ok(parseCanonicalAddress("127.0.0.1"));
  });
});
