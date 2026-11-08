import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  BrokerEnforcer,
  beginConsume,
  computeClaimKey,
  emptyLedger,
  finalizeConsume,
  statusOf,
  validateEgressClaim,
  type BeginResult,
  type ConnectOutcome,
  type EgressClaim,
  type LedgerPort,
  type PolicyView,
  type SettledOutcome,
  type SingleUseLedger,
} from "../src/security/tcpCheck/index.js";

// --- a canonical, allowlisted claim + policy ----------------------------

function makeClaim(overrides: Partial<EgressClaim> = {}): EgressClaim {
  return {
    owner: "owner-1",
    project: "proj-1",
    actionFingerprint: "fp-abc",
    target: { ip: "8.8.8.8", port: 443 },
    fenceToken: 7,
    policyEpoch: 3,
    deadlineMs: 5000,
    expiresAtMs: Date.parse("2026-11-21T00:00:00Z"),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    allowlist: { entries: [{ ip: "8.8.8.8", ports: [443] }] },
    snapshotDate: "2026-11-07T00:00:00Z",
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 3,
    ...overrides,
  };
}

// nowMs comfortably within freshness of the snapshot and before expiry.
const NOW = Date.parse("2026-11-20T00:00:00Z");

describe("validateEgressClaim", () => {
  it("accepts a well-formed claim and names each failure", () => {
    assert.equal(validateEgressClaim(makeClaim()), "ok");
    assert.equal(validateEgressClaim(makeClaim({ owner: "" })), "malformed-identity");
    assert.equal(
      validateEgressClaim(makeClaim({ target: { ip: "08.8.8.8", port: 443 } })),
      "malformed-target",
    );
    assert.equal(
      validateEgressClaim(makeClaim({ target: { ip: "8.8.8.8", port: 0 } })),
      "bad-port",
    );
    assert.equal(
      validateEgressClaim(makeClaim({ target: { ip: "8.8.8.8", port: 70000 } })),
      "bad-port",
    );
    assert.equal(validateEgressClaim(makeClaim({ fenceToken: 1.5 })), "bad-fence");
    assert.equal(validateEgressClaim(makeClaim({ policyEpoch: Number.NaN })), "bad-epoch");
    assert.equal(validateEgressClaim(makeClaim({ deadlineMs: 0 })), "bad-deadline");
    assert.equal(validateEgressClaim(makeClaim({ expiresAtMs: Number.NaN })), "bad-expiry");
  });
});

describe("computeClaimKey", () => {
  it("is stable across fence token and policy epoch, but binds owner/action/target", () => {
    const base = computeClaimKey(makeClaim());
    assert.equal(computeClaimKey(makeClaim({ fenceToken: 999, policyEpoch: 42 })), base);
    assert.notEqual(computeClaimKey(makeClaim({ owner: "owner-2" })), base);
    assert.notEqual(computeClaimKey(makeClaim({ actionFingerprint: "fp-xyz" })), base);
    assert.notEqual(computeClaimKey(makeClaim({ target: { ip: "8.8.8.8", port: 80 } })), base);
    assert.notEqual(computeClaimKey(makeClaim({ target: { ip: "1.1.1.1", port: 443 } })), base);
  });
});

describe("single-use ledger", () => {
  it("reserves, settles, and returns the stored status on replay", () => {
    const key = "k1";
    let ledger = emptyLedger();
    const begin = beginConsume(ledger, { claimKey: key, nowMs: 1 });
    assert.equal(begin.kind, "fresh");
    if (begin.kind !== "fresh") return;
    ledger = begin.ledger;

    // mid-flight replay → consuming (uncertain)
    assert.equal(beginConsume(ledger, { claimKey: key, nowMs: 2 }).kind, "replay-consuming");

    const fin = finalizeConsume(ledger, { claimKey: key, outcome: "completed", nowMs: 3 });
    assert.equal(fin.reason, "ok");
    ledger = fin.ledger;
    assert.equal(statusOf(ledger, key)?.phase, "settled");

    const replay = beginConsume(ledger, { claimKey: key, nowMs: 4 });
    assert.equal(replay.kind, "replay-settled");
    if (replay.kind === "replay-settled") assert.equal(replay.entry.outcome, "completed");
  });

  it("refuses to re-finalize or finalize a missing key, and fails closed on bad input", () => {
    let ledger = beginConsume(emptyLedger(), { claimKey: "k", nowMs: 1 }).ledger as SingleUseLedger;
    ledger = finalizeConsume(ledger, { claimKey: "k", outcome: "failed", nowMs: 2 }).ledger;
    // second finalize is refused and does not overwrite
    const again = finalizeConsume(ledger, { claimKey: "k", outcome: "completed", nowMs: 3 });
    assert.equal(again.reason, "already-settled");
    assert.equal(statusOf(again.ledger, "k")?.outcome, "failed");

    assert.equal(
      finalizeConsume(ledger, { claimKey: "missing", outcome: "failed", nowMs: 4 }).reason,
      "no-entry",
    );
    assert.equal(beginConsume(ledger, { claimKey: "", nowMs: 1 }).kind, "invalid-input");
    assert.equal(
      finalizeConsume(ledger, {
        claimKey: "k",
        outcome: "bogus" as SettledOutcome,
        nowMs: 5,
      }).reason,
      "invalid-input",
    );
  });
});

// --- BrokerEnforcer with injected fakes (no real network) ---------------

/** An in-memory async ledger port over the pure reducer. */
function inMemoryLedgerPort(): LedgerPort & { ledger: SingleUseLedger } {
  const port = {
    ledger: emptyLedger(),
    begin(claimKey: string, nowMs: number): BeginResult {
      const r = beginConsume(port.ledger, { claimKey, nowMs });
      if (r.kind === "fresh") port.ledger = r.ledger;
      return r;
    },
    finalize(claimKey: string, outcome: SettledOutcome, nowMs: number): void {
      port.ledger = finalizeConsume(port.ledger, { claimKey, outcome, nowMs }).ledger;
    },
  };
  return port;
}

interface Harness {
  readonly enforcer: BrokerEnforcer;
  readonly ledgerPort: ReturnType<typeof inMemoryLedgerPort>;
  readonly connectCalls: number;
}

function harness(opts: {
  policy?: PolicyView;
  fenceActive?: boolean;
  nowMs?: number;
  connect?: ConnectOutcome | (() => Promise<ConnectOutcome>);
}): Harness {
  const ledgerPort = inMemoryLedgerPort();
  const state = { connectCalls: 0 };
  const enforcer = new BrokerEnforcer({
    policy: () => opts.policy ?? makePolicy(),
    fence: { isActive: () => opts.fenceActive ?? true },
    ledger: ledgerPort,
    clock: () => opts.nowMs ?? NOW,
    connector: {
      async connect(): Promise<ConnectOutcome> {
        state.connectCalls += 1;
        if (typeof opts.connect === "function") return opts.connect();
        return opts.connect ?? "completed";
      },
    },
  });
  return {
    enforcer,
    ledgerPort,
    get connectCalls(): number {
      return state.connectCalls;
    },
  };
}

describe("BrokerEnforcer — pre-connect gate (never-admitted, no socket)", () => {
  it("connects on the happy path and emits socket-closed", async () => {
    const h = harness({});
    const r = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(r.outcome, "completed");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(h.connectCalls, 1);
    assert.equal(statusOf(h.ledgerPort.ledger, computeClaimKey(makeClaim()))?.phase, "settled");
  });

  const rejectCases: Array<[string, Parameters<typeof harness>[0], EgressClaim, string]> = [
    ["superseded fence", { fenceActive: false }, makeClaim(), "fence_superseded"],
    ["expired capability", { nowMs: NOW }, makeClaim({ expiresAtMs: NOW - 1 }), "expired"],
    [
      "policy epoch moved",
      { policy: makePolicy({ policyEpoch: 99 }) },
      makeClaim(),
      "policy_changed",
    ],
    [
      "target narrowed out of the allowlist",
      { policy: makePolicy({ allowlist: { entries: [{ ip: "1.1.1.1", ports: [443] }] } }) },
      makeClaim(),
      "policy_changed",
    ],
    [
      "special-use target",
      {},
      makeClaim({ target: { ip: "127.0.0.1", port: 443 } }),
      "not_authorized",
    ],
    ["malformed claim", {}, makeClaim({ owner: "" }), "not_authorized"],
    [
      "stale table snapshot",
      { policy: makePolicy({ maxAgeMs: 1 }) },
      makeClaim(),
      "policy_changed",
    ],
  ];

  for (const [name, opts, claim, expected] of rejectCases) {
    it(`refuses (${name}) → ${expected}, opens no socket`, async () => {
      const h = harness(opts);
      const r = await h.enforcer.authorizeAndConnect(claim);
      assert.equal(r.outcome, expected);
      assert.equal(r.admissionSignal, "never-admitted");
      assert.equal(h.connectCalls, 0, "no socket on a rejected claim");
    });
  }
});

describe("BrokerEnforcer — single-use at the egress boundary", () => {
  it("a duplicate delivery of a settled claim returns the stored status, never a second connect", async () => {
    const h = harness({ connect: "failed" });
    const first = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(first.outcome, "failed");
    assert.equal(first.admissionSignal, "socket-closed");

    const replay = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.storedOutcome, "failed");
    assert.equal(replay.admissionSignal, null);
    assert.equal(h.connectCalls, 1, "the second delivery must not reconnect");
  });

  it("a connector crash leaves the claim uncertain; a replay stays uncertain, never reconnects", async () => {
    const h = harness({
      connect: () => Promise.reject(new Error("mediator crashed mid-connect")),
    });
    const first = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(first.outcome, "effect_uncertain");
    assert.equal(first.admissionSignal, null);
    // entry is still consuming (no recorded result)
    assert.equal(statusOf(h.ledgerPort.ledger, computeClaimKey(makeClaim()))?.phase, "consuming");

    const replay = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(replay.outcome, "effect_uncertain");
    assert.equal(replay.admissionSignal, null);
    assert.equal(h.connectCalls, 1, "a replay of an uncertain effect must not reconnect");
  });

  it("maps each connector outcome through and always signals socket-closed", async () => {
    for (const outcome of ["completed", "failed", "timed-out", "cancelled"] as ConnectOutcome[]) {
      const h = harness({ connect: outcome });
      const r = await h.enforcer.authorizeAndConnect(
        makeClaim({ actionFingerprint: `fp-${outcome}` }),
      );
      assert.equal(r.outcome, outcome);
      assert.equal(r.admissionSignal, "socket-closed");
    }
  });
});

describe("BrokerEnforcer — ordering", () => {
  let order: string[];
  beforeEach(() => {
    order = [];
  });

  it("consumes single-use only after the gate passes and before the socket", async () => {
    const ledgerPort = inMemoryLedgerPort();
    const enforcer = new BrokerEnforcer({
      policy: () => makePolicy(),
      fence: {
        isActive: () => {
          order.push("fence");
          return true;
        },
      },
      ledger: {
        begin(claimKey, nowMs) {
          order.push("begin");
          return ledgerPort.begin(claimKey, nowMs);
        },
        finalize(claimKey, outcome, nowMs) {
          order.push("finalize");
          ledgerPort.finalize(claimKey, outcome, nowMs);
        },
      },
      clock: () => NOW,
      connector: {
        async connect() {
          order.push("connect");
          return "completed";
        },
      },
    });
    await enforcer.authorizeAndConnect(makeClaim());
    assert.deepEqual(order, ["fence", "begin", "connect", "finalize"]);
  });

  it("does not consume single-use when the gate rejects", async () => {
    const h = harness({ fenceActive: false });
    await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(statusOf(h.ledgerPort.ledger, computeClaimKey(makeClaim())), null);
  });
});
