// Provider-level residual regressions from the Codex re-review of 6d2ab5ae:
// #1 fence identity, #2 attempt-scoped cleanup, #3 provider-path duplicate
// semantics while the original connector is pending, #4 uncertain lifecycle.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginConsume,
  computeAllowlistDigest,
  computeClaimKey,
  createInMemoryAdmissionStore,
  createTcpCheckProvider,
  emptyLedger,
  finalizeConsume,
  statusOf,
  type ConnectOutcome,
  type LedgerPort,
  type PolicyView,
  type SettledOutcome,
  type SingleUseLedger,
  type TcpCheckProviderDeps,
} from "../src/security/tcpCheck/index.js";

const ALLOWLIST = { entries: [{ ip: "8.8.8.8", ports: [443] }] } as const;
const APPROVED = computeAllowlistDigest(ALLOWLIST);
const NOW = Date.parse("2026-11-20T00:00:00Z");

function makePolicy(): PolicyView {
  return {
    allowlist: ALLOWLIST,
    snapshotDate: "2026-11-09T00:00:00Z",
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 1,
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

function identity(fingerprint: string, owner = "owner-1") {
  return {
    owner,
    project: "proj-1",
    actionFingerprint: fingerprint,
    approvedAllowlistDigest: APPROVED,
    correlationId: "c",
  };
}

describe("Codex #1 — fence identity is the claim key, not the attemptId", () => {
  it("a key-checking fence admits a valid prepared attempt and rejects a wrong key", async () => {
    const admission = createInMemoryAdmissionStore();
    const ledger = inMemoryLedgerPort();
    let connects = 0;
    // The fence is only satisfied by the claim key; if the provider passed the
    // attemptId instead, this valid attempt would be wrongly rejected.
    const deps: TcpCheckProviderDeps = {
      policy: makePolicy,
      admission,
      ledger,
      clock: () => NOW,
      fence: { isActive: (_token, key) => key.length === 64 && /^[0-9a-f]{64}$/.test(key) },
      connector: {
        async connect(): Promise<ConnectOutcome> {
          connects += 1;
          return "connected";
        },
      },
    };
    const provider = createTcpCheckProvider(deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-ok"));
    // The fence key the provider will present equals computeClaimKey(claim).
    assert.match(computeClaimKey(attempt.claim), /^[0-9a-f]{64}$/);
    const r = await provider.sendPrepared(attempt);
    assert.equal(r.status, "connected");
    assert.equal(connects, 1);
  });

  it("rejects when the fence does not recognise the claim key", async () => {
    const admission = createInMemoryAdmissionStore();
    const deps: TcpCheckProviderDeps = {
      policy: makePolicy,
      admission,
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: (_token, key) => key === "a-key-that-never-matches" },
      connector: {
        async connect(): Promise<ConnectOutcome> {
          return "connected";
        },
      },
    };
    const provider = createTcpCheckProvider(deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-x"));
    const r = await provider.sendPrepared(attempt);
    assert.equal(r.status, "fence_superseded");
    assert.equal(admission.snapshot("owner-1").active, null); // self-cleaned
  });
});

describe("Codex #3/#4 — provider-path duplicate and uncertain lifecycle", () => {
  function controllablePending() {
    let resolveConnect!: (o: ConnectOutcome) => void;
    let rejectConnect!: (e: unknown) => void;
    const pending = new Promise<ConnectOutcome>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    let calls = 0;
    const connector = {
      connect(): Promise<ConnectOutcome> {
        calls += 1;
        return pending;
      },
    };
    return { connector, settle: resolveConnect!, fail: rejectConnect!, calls: () => calls };
  }

  it("a re-delivery while the original is in flight is refused and leaves the original untouched", async () => {
    const admission = createInMemoryAdmissionStore();
    const ledger = inMemoryLedgerPort();
    const c = controllablePending();
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger,
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: c.connector,
    });
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-dup"));
    const inFlight = provider.sendPrepared(attempt); // connector is pending
    while (c.calls() === 0) await Promise.resolve(); // original has reached connect
    const claimKey = computeClaimKey(attempt.claim);
    assert.equal(admission.snapshot("owner-1").active?.phase, "started");
    assert.equal(statusOf(ledger.ledger, claimKey)?.phase, "consuming");

    // A re-delivery of the SAME prepared attempt: start fails (already started),
    // so it is refused without touching the in-flight attempt or its ledger.
    const dup = await provider.sendPrepared(attempt);
    assert.equal(dup.status, "fence_superseded");
    assert.equal(c.calls(), 1, "the duplicate did not reconnect");
    assert.equal(
      admission.snapshot("owner-1").active?.phase,
      "started",
      "original still in flight",
    );
    assert.equal(
      statusOf(ledger.ledger, claimKey)?.phase,
      "consuming",
      "original ledger untouched",
    );

    // Let the original finish.
    c.settle("connected");
    assert.equal((await inFlight).status, "connected");
    assert.equal(admission.snapshot("owner-1").active, null);
  });

  it("a new delivery while the original is in flight is slot-busy at prepare", async () => {
    const admission = createInMemoryAdmissionStore();
    const c = controllablePending();
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: c.connector,
    });
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-a"));
    const inFlight = provider.sendPrepared(attempt);
    while (c.calls() === 0) await Promise.resolve();
    await assert.rejects(
      provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-b")),
      /slot-busy/,
    );
    c.settle("refused");
    await inFlight;
  });

  it("#4: an uncertain effect holds the slot as uncertain, then resolves on a signal (not time)", async () => {
    const admission = createInMemoryAdmissionStore();
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: { connect: () => Promise.reject(new Error("mediator crash")) },
    });
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-u"));
    const r = await provider.sendPrepared(attempt);
    assert.equal(r.status, "effect_uncertain");
    // The slot is held as `uncertain`, not left `started`.
    assert.equal(admission.snapshot("owner-1").active?.phase, "uncertain");
    // Still blocked: a new attempt cannot be admitted while uncertain.
    await assert.rejects(
      provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-next")),
      /slot-busy/,
    );
    // The enforcer's durable closure signal resolves ONLY this attempt's slot.
    const resolved = await provider.resolveUncertain("owner-1", attempt.attemptId, "socket-closed");
    assert.equal(resolved, true);
    assert.equal(admission.snapshot("owner-1").active, null);
    // Now a fresh attempt is admitted again.
    const next = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-next2"));
    assert.equal(next.claim.target.ip, "8.8.8.8");
  });

  it("#4: resolveUncertain refuses to resolve a different attempt's slot", async () => {
    const admission = createInMemoryAdmissionStore();
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: { connect: () => Promise.reject(new Error("crash")) },
    });
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-u"));
    await provider.sendPrepared(attempt);
    // A wrong attemptId must not release the uncertain slot.
    assert.equal(
      await provider.resolveUncertain("owner-1", "someone-else", "socket-closed"),
      false,
    );
    assert.equal(admission.snapshot("owner-1").active?.phase, "uncertain");
  });
});
