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
  createInMemoryClaimBindingStore,
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

describe("prepared claim snapshot across asynchronous fences", () => {
  for (const pausedFence of [1, 2]) {
    it(`keeps the approved target when a mutable copy changes during fence ${pausedFence}`, async () => {
      const allowlist = { entries: [{ ip: "8.8.8.8", ports: [443, 8443] }] } as const;
      let resume!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let fences = 0;
      const ports: number[] = [];
      const ledger = inMemoryLedgerPort();
      const provider = createTcpCheckProvider({
        policy: () => ({ ...makePolicy(), allowlist }),
        admission: createInMemoryAdmissionStore(),
        ledger,
        clock: () => NOW,
        fence: {
          async isActive() {
            fences += 1;
            if (fences === pausedFence) {
              reached();
              await barrier;
            }
            return true;
          },
        },
        connector: {
          async connect(target): Promise<ConnectOutcome> {
            ports.push(target.port);
            return "connected";
          },
        },
      });
      const prepared = await provider.prepare(
        { ip: "8.8.8.8", port: 443 },
        {
          ...identity("fp-mutable-copy"),
          approvedAllowlistDigest: computeAllowlistDigest(allowlist),
        },
      );
      const supplied = {
        ...prepared,
        claim: { ...prepared.claim, target: { ...prepared.claim.target } },
      };
      const result = provider.sendPrepared(supplied);
      await paused;
      supplied.claim.target.port = 8443;
      resume();
      const receipt = await result;
      assert.equal(receipt.status, "connected");
      assert.deepEqual(ports, [443], "only the bound target may reach the connector");
      assert.equal(receipt.target, "8.8.8.8:443");
      assert.equal(statusOf(ledger.ledger, computeClaimKey(prepared.claim))?.phase, "settled");
    });
  }
});

function makePolicy(): PolicyView {
  return {
    allowlist: ALLOWLIST,
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
  it("pre-send release cannot clear a started or later reservation or a forged identity", async () => {
    const admission = createInMemoryAdmissionStore();
    let settle!: (outcome: ConnectOutcome) => void;
    let reached!: () => void;
    const pending = new Promise<ConnectOutcome>((resolve) => {
      settle = resolve;
    });
    const connected = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: {
        connect() {
          reached();
          return pending;
        },
      },
    });
    const first = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-release"));
    assert.equal(await provider.releasePrepared({ ...first, owner: "other-owner" }), false);
    assert.equal(
      await provider.releasePrepared({ ...first, claim: { ...first.claim, deadlineMs: 1 } }),
      false,
    );
    assert.equal(admission.snapshot("owner-1").active?.phase, "reserved");
    const running = provider.sendPrepared(first);
    await connected;
    assert.equal(await provider.releasePrepared(first), false);
    assert.equal(admission.snapshot("owner-1").active?.phase, "started");
    settle("connected");
    await running;
    const later = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-later"));
    assert.equal(await provider.releasePrepared(first), false);
    assert.equal(admission.snapshot("owner-1").active?.attemptId, later.attemptId);
    assert.equal(await provider.releasePrepared(later), true);
    assert.equal(admission.snapshot("owner-1").active, null);
  });

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

describe("Codex round 4 — claim integrity (#1) and thrown-dependency lifecycle (#2)", () => {
  const TWO_PORT_ALLOWLIST = { entries: [{ ip: "8.8.8.8", ports: [443, 8443] }] } as const;
  const twoPortPolicy = (): PolicyView => ({
    allowlist: TWO_PORT_ALLOWLIST,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 1,
  });

  it("#1: the prepared claim is frozen — an in-place target mutation throws", async () => {
    const provider = createTcpCheckProvider({
      policy: twoPortPolicy,
      admission: createInMemoryAdmissionStore(),
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: {
        async connect(): Promise<ConnectOutcome> {
          return "connected";
        },
      },
    });
    const attempt = await provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      {
        ...identity("fp-mut"),
        approvedAllowlistDigest: computeAllowlistDigest(TWO_PORT_ALLOWLIST),
      },
    );
    assert.throws(() => {
      (attempt.claim.target as { port: number }).port = 8443;
    });
  });

  it("#1: a fabricated/substituted claim (different port, also allowlisted) is refused", async () => {
    let connects = 0;
    let connectedPort = -1;
    const provider = createTcpCheckProvider({
      policy: twoPortPolicy,
      admission: createInMemoryAdmissionStore(),
      ledger: inMemoryLedgerPort(),
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: {
        async connect(target): Promise<ConnectOutcome> {
          connects += 1;
          connectedPort = target.port;
          return "connected";
        },
      },
    });
    const attempt = await provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      {
        ...identity("fp-sub"),
        approvedAllowlistDigest: computeAllowlistDigest(TWO_PORT_ALLOWLIST),
      },
    );
    // A new attempt object carrying a claim with port 8443 (which IS allowlisted),
    // same attemptId — must be rejected by the reservation binding, not admitted.
    const forged = {
      ...attempt,
      claim: { ...attempt.claim, target: { ip: "8.8.8.8", port: 8443 } },
    };
    const r = await provider.sendPrepared(forged);
    assert.equal(r.status, "not_authorized");
    assert.equal(r.admissionSignal, "never-admitted");
    assert.equal(connects, 0, "no socket opened for a forged claim");
    assert.equal(connectedPort, -1);
  });

  it("#2: a thrown ledger.begin leaves the slot uncertain (not started) and is resolvable", async () => {
    const admission = createInMemoryAdmissionStore();
    let connects = 0;
    const provider = createTcpCheckProvider({
      policy: makePolicy,
      admission,
      ledger: {
        begin() {
          throw new Error("ledger backend unavailable");
        },
        finalize() {},
      },
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: {
        async connect(): Promise<ConnectOutcome> {
          connects += 1;
          return "connected";
        },
      },
    });
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-throw"));
    const r = await provider.sendPrepared(attempt);
    assert.equal(r.status, "effect_uncertain"); // no raw error leaked
    assert.equal(r.admissionSignal, null);
    assert.equal(connects, 0, "the connector was never reached");
    // The slot is held as uncertain, NOT left started.
    assert.equal(admission.snapshot("owner-1").active?.phase, "uncertain");
    // It is recoverable via a genuine durable enforcer signal.
    const resolved = await provider.resolveUncertain(
      "owner-1",
      attempt.attemptId,
      "never-admitted",
    );
    assert.equal(resolved, true);
    assert.equal(admission.snapshot("owner-1").active, null);
  });
});

describe("Codex round 4 residual #2 — completed replay returns the stored outcome", () => {
  function connectingProviderDeps(bindingStore = createInMemoryClaimBindingStore()) {
    const admission = createInMemoryAdmissionStore();
    const ledger = inMemoryLedgerPort();
    const state = { connects: 0 };
    const deps: TcpCheckProviderDeps = {
      policy: makePolicy,
      admission,
      ledger,
      bindingStore,
      clock: () => NOW,
      fence: { isActive: () => true },
      connector: {
        async connect(): Promise<ConnectOutcome> {
          state.connects += 1;
          return "connected";
        },
      },
    };
    return { deps, admission, ledger, bindingStore, connects: () => state.connects };
  }

  it("a completed duplicate replays `connected` with its stored outcome and never reconnects", async () => {
    const h = connectingProviderDeps();
    const provider = createTcpCheckProvider(h.deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-done"));
    const first = await provider.sendPrepared(attempt);
    assert.equal(first.status, "connected");

    const replay = await provider.sendPrepared(attempt);
    assert.equal(replay.status, "replayed");
    assert.equal(replay.storedOutcome, "connected");
    assert.equal(h.connects(), 1, "one connect total");
    assert.equal(h.admission.snapshot("owner-1").active, null);
  });

  it("a lost first response (dropped) still replays on retry with one connect", async () => {
    const h = connectingProviderDeps();
    const provider = createTcpCheckProvider(h.deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-lost"));
    await provider.sendPrepared(attempt); // response "lost" (ignored)
    const retry = await provider.sendPrepared(attempt);
    assert.equal(retry.status, "replayed");
    assert.equal(retry.storedOutcome, "connected");
    assert.equal(h.connects(), 1);
  });

  it("a recreated provider with the same ledger + binding store replays; a fresh store fails closed", async () => {
    const store = createInMemoryClaimBindingStore();
    const h = connectingProviderDeps(store);
    const provider1 = createTcpCheckProvider(h.deps);
    const attempt = await provider1.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-recreate"));
    assert.equal((await provider1.sendPrepared(attempt)).status, "connected");

    // A new provider instance sharing the same admission, ledger and binding store.
    const provider2 = createTcpCheckProvider({ ...h.deps });
    const replay = await provider2.sendPrepared(attempt);
    assert.equal(replay.status, "replayed");
    assert.equal(replay.storedOutcome, "connected");

    // A provider with a FRESH binding store cannot authenticate the attempt.
    const provider3 = createTcpCheckProvider({
      ...h.deps,
      admission: createInMemoryAdmissionStore(),
      bindingStore: createInMemoryClaimBindingStore(),
    });
    const refused = await provider3.sendPrepared(attempt);
    assert.equal(refused.status, "not_authorized");
    assert.equal(h.connects(), 1, "no reconnect across any replay path");
  });

  it("a rejected (never-admitted) attempt fails closed on replay, not replayed", async () => {
    const h = connectingProviderDeps();
    // Fence refuses -> never-admitted, binding removed.
    const deps = { ...h.deps, fence: { isActive: () => false } };
    const provider = createTcpCheckProvider(deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity("fp-rej"));
    assert.equal((await provider.sendPrepared(attempt)).status, "fence_superseded");
    // A replay of a rejected attempt is not_authorized (fail-closed), not replayed.
    assert.equal((await provider.sendPrepared(attempt)).status, "not_authorized");
  });
});
