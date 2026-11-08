import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BrokerEnforcer,
  beginConsume,
  computeAllowlistDigest,
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

const ALLOWLIST = { entries: [{ ip: "8.8.8.8", ports: [443] }] } as const;
const APPROVED_DIGEST = computeAllowlistDigest(ALLOWLIST);
const NOW = Date.parse("2026-11-20T00:00:00Z");

function makeClaim(overrides: Partial<EgressClaim> = {}): EgressClaim {
  return {
    owner: "owner-1",
    project: "proj-1",
    actionFingerprint: "fp-abc",
    target: { ip: "8.8.8.8", port: 443 },
    fenceToken: 7,
    policyEpoch: 3,
    approvedAllowlistDigest: APPROVED_DIGEST,
    deadlineMs: 5000,
    expiresAtMs: Date.parse("2026-11-21T00:00:00Z"),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    allowlist: ALLOWLIST,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 3,
    ...overrides,
  };
}

describe("validateEgressClaim", () => {
  it("accepts a well-formed claim and names each failure, including the digest", () => {
    assert.equal(validateEgressClaim(makeClaim()), "ok");
    assert.equal(validateEgressClaim(makeClaim({ owner: "" })), "malformed-identity");
    assert.equal(validateEgressClaim(makeClaim({ fenceToken: 1.5 })), "bad-fence");
    assert.equal(validateEgressClaim(makeClaim({ policyEpoch: Number.NaN })), "bad-epoch");
    assert.equal(validateEgressClaim(makeClaim({ approvedAllowlistDigest: "nope" })), "bad-digest");
    assert.equal(validateEgressClaim(makeClaim({ deadlineMs: 0 })), "bad-deadline");
    assert.equal(validateEgressClaim(makeClaim({ expiresAtMs: Number.NaN })), "bad-expiry");
  });
});

describe("computeClaimKey", () => {
  it("is stable across fence/epoch/digest, but binds owner/action/target", () => {
    const base = computeClaimKey(makeClaim());
    assert.equal(
      computeClaimKey(
        makeClaim({ fenceToken: 999, policyEpoch: 42, approvedAllowlistDigest: "f".repeat(64) }),
      ),
      base,
    );
    assert.notEqual(computeClaimKey(makeClaim({ owner: "owner-2" })), base);
    assert.notEqual(computeClaimKey(makeClaim({ actionFingerprint: "fp-xyz" })), base);
    assert.notEqual(computeClaimKey(makeClaim({ target: { ip: "8.8.8.8", port: 80 } })), base);
  });
});

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

describe("single-use ledger", () => {
  it("reserves, settles with the new taxonomy, and returns the stored status on replay", () => {
    const key = "k1";
    let ledger = emptyLedger();
    const begin = beginConsume(ledger, { claimKey: key, nowMs: 1 });
    assert.equal(begin.kind, "fresh");
    if (begin.kind !== "fresh") return;
    ledger = begin.ledger;
    assert.equal(beginConsume(ledger, { claimKey: key, nowMs: 2 }).kind, "replay-consuming");
    ledger = finalizeConsume(ledger, { claimKey: key, outcome: "connected", nowMs: 3 }).ledger;
    const replay = beginConsume(ledger, { claimKey: key, nowMs: 4 });
    assert.equal(replay.kind, "replay-settled");
    if (replay.kind === "replay-settled") assert.equal(replay.entry.outcome, "connected");
  });

  it("rejects an invalid settled outcome", () => {
    const ledger = beginConsume(emptyLedger(), { claimKey: "k", nowMs: 1 })
      .ledger as SingleUseLedger;
    assert.equal(
      finalizeConsume(ledger, { claimKey: "k", outcome: "completed" as SettledOutcome, nowMs: 2 })
        .reason,
      "invalid-input",
    );
  });
});

interface Harness {
  readonly enforcer: BrokerEnforcer;
  readonly ledgerPort: ReturnType<typeof inMemoryLedgerPort>;
  readonly connectCalls: number;
}

function harness(opts: {
  policy?: PolicyView;
  fenceActive?: boolean | (() => boolean);
  nowMs?: number | (() => number);
  connect?: ConnectOutcome | (() => Promise<ConnectOutcome>);
  ledgerPort?: ReturnType<typeof inMemoryLedgerPort>;
}): Harness {
  const ledgerPort = opts.ledgerPort ?? inMemoryLedgerPort();
  const state = { connectCalls: 0 };
  const enforcer = new BrokerEnforcer({
    policy: () => opts.policy ?? makePolicy(),
    fence: {
      isActive: () =>
        typeof opts.fenceActive === "function" ? opts.fenceActive() : (opts.fenceActive ?? true),
    },
    ledger: ledgerPort,
    clock: () => (typeof opts.nowMs === "function" ? opts.nowMs() : (opts.nowMs ?? NOW)),
    connector: {
      async connect(): Promise<ConnectOutcome> {
        state.connectCalls += 1;
        if (typeof opts.connect === "function") return opts.connect();
        return opts.connect ?? "connected";
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

describe("BrokerEnforcer — happy path and gate", () => {
  it("connects on the happy path, settles the ledger, and emits socket-closed", async () => {
    const h = harness({});
    const r = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(r.outcome, "connected");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(h.connectCalls, 1);
    assert.equal(statusOf(h.ledgerPort.ledger, computeClaimKey(makeClaim()))?.outcome, "connected");
  });

  const rejectCases: Array<[string, Parameters<typeof harness>[0], EgressClaim, string]> = [
    ["superseded fence", { fenceActive: false }, makeClaim(), "fence_superseded"],
    ["expired", {}, makeClaim({ expiresAtMs: NOW - 1 }), "expired"],
    ["epoch moved", { policy: makePolicy({ policyEpoch: 99 }) }, makeClaim(), "policy_changed"],
    [
      "approved digest no longer matches the active policy (Codex #4)",
      { policy: makePolicy({ allowlist: { entries: [{ ip: "8.8.8.8", ports: [443, 53] }] } }) },
      makeClaim(),
      "policy_changed",
    ],
    [
      "special-use target",
      {},
      makeClaim({ target: { ip: "127.0.0.1", port: 443 } }),
      "not_authorized",
    ],
    ["stale table", { policy: makePolicy({ maxAgeMs: 1 }) }, makeClaim(), "policy_changed"],
  ];

  for (const [name, opts, claim, expected] of rejectCases) {
    it(`refuses (${name}) → ${expected}, opens no socket`, async () => {
      const h = harness(opts);
      const r = await h.enforcer.authorizeAndConnect(claim);
      assert.equal(r.outcome, expected);
      assert.equal(r.admissionSignal, "never-admitted");
      assert.equal(h.connectCalls, 0);
    });
  }
});

describe("BrokerEnforcer — Codex #2 (post-await gate), #3 (ledger before gate), #7 (abort)", () => {
  it("#2: a claim that expires DURING the fence await is still refused before connect", async () => {
    // The fence check advances the clock past expiry, so a gate captured before
    // the await would wrongly pass. The gate must read the clock after the await.
    let now = NOW;
    const claim = makeClaim({ expiresAtMs: NOW + 1000 });
    const h = harness({
      nowMs: () => now,
      fenceActive: () => {
        now = NOW + 5000; // time passes during the async fence check
        return true;
      },
    });
    const r = await h.enforcer.authorizeAndConnect(claim);
    assert.equal(r.outcome, "expired");
    assert.equal(h.connectCalls, 0);
  });

  it("#3: a duplicate of an in-flight claim returns effect_uncertain even when expired", async () => {
    const ledgerPort = inMemoryLedgerPort();
    // Seed the ledger as `consuming` for this claim (the original is in flight).
    ledgerPort.begin(computeClaimKey(makeClaim()), NOW);
    const h = harness({ ledgerPort });
    // The duplicate is expired, but because its ledger entry is already
    // consuming, the gate rejection must NOT fire — it returns uncertain.
    const r = await h.enforcer.authorizeAndConnect(makeClaim({ expiresAtMs: NOW - 1 }));
    assert.equal(r.outcome, "effect_uncertain");
    assert.equal(r.admissionSignal, null);
    assert.equal(h.connectCalls, 0);
  });

  it("#7: an already-aborted signal opens no socket and records a terminal cancelled", async () => {
    const h = harness({});
    const controller = new AbortController();
    controller.abort();
    const r = await h.enforcer.authorizeAndConnect(makeClaim(), controller.signal);
    assert.equal(r.outcome, "cancelled");
    assert.equal(r.admissionSignal, "socket-closed");
    assert.equal(h.connectCalls, 0);
    // consumed and settled cancelled, so a redelivery replays rather than reconnects
    assert.equal(statusOf(h.ledgerPort.ledger, computeClaimKey(makeClaim()))?.outcome, "cancelled");
  });

  it("#2-residual: a fence superseded DURING the ledger await is caught before connect", async () => {
    // The fence goes inactive during the ledger.begin await; because the fence is
    // checked after that await (right before connect), it is caught.
    let fenceActive = true;
    const ledgerPort = inMemoryLedgerPort();
    const slowBegin: typeof ledgerPort = {
      ledger: ledgerPort.ledger,
      begin(claimKey: string, nowMs: number) {
        fenceActive = false; // superseded while we were consuming
        return ledgerPort.begin(claimKey, nowMs);
      },
      finalize: ledgerPort.finalize,
    };
    const h = harness({ ledgerPort: slowBegin, fenceActive: () => fenceActive });
    const r = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(r.outcome, "fence_superseded");
    assert.equal(h.connectCalls, 0);
  });

  it("#3-residual: an aborted/superseded IN-FLIGHT duplicate returns uncertain, never frees the slot", async () => {
    const ledgerPort = inMemoryLedgerPort();
    ledgerPort.begin(computeClaimKey(makeClaim()), NOW); // original in flight (consuming)
    // The duplicate is both aborted AND fence-superseded, yet because the ledger
    // is consulted first, it returns effect_uncertain (not cancelled/never-admitted).
    const h = harness({ ledgerPort, fenceActive: false });
    const controller = new AbortController();
    controller.abort();
    const r = await h.enforcer.authorizeAndConnect(makeClaim(), controller.signal);
    assert.equal(r.outcome, "effect_uncertain");
    assert.equal(r.admissionSignal, null);
    assert.equal(h.connectCalls, 0);
  });

  it("maps each connector outcome through and always signals socket-closed", async () => {
    for (const outcome of ["connected", "refused", "timed-out", "error"] as ConnectOutcome[]) {
      const h = harness({ connect: outcome });
      const r = await h.enforcer.authorizeAndConnect(
        makeClaim({ actionFingerprint: `fp-${outcome}` }),
      );
      assert.equal(r.outcome, outcome);
      assert.equal(r.admissionSignal, "socket-closed");
    }
  });
});

describe("BrokerEnforcer — single-use duplicate/crash", () => {
  it("a settled replay returns the stored status, never a second connect", async () => {
    const h = harness({ connect: "refused" });
    await h.enforcer.authorizeAndConnect(makeClaim());
    const replay = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.storedOutcome, "refused");
    assert.equal(replay.admissionSignal, null);
    assert.equal(h.connectCalls, 1);
  });

  it("a connector crash leaves the claim uncertain; a replay never reconnects", async () => {
    const h = harness({ connect: () => Promise.reject(new Error("crash")) });
    const first = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(first.outcome, "effect_uncertain");
    const replay = await h.enforcer.authorizeAndConnect(makeClaim());
    assert.equal(replay.outcome, "effect_uncertain");
    assert.equal(h.connectCalls, 1);
  });
});
