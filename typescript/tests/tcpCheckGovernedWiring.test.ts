import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BrokerEnforcer,
  TCP_CHECK_OPERATION,
  SECURITY_TOOL,
  TCP_CHECK_PROVIDER_NAME,
  TcpCheckNotCommissionedError,
  beginConsume,
  createTcpCheckProvider,
  createTcpCheckProviderFromEnv,
  createTcpCheckToolDefinition,
  emptyAdmissionState,
  emptyLedger,
  finalizeConsume,
  tcpCheckArgumentsSchema,
  type AdmissionState,
  type AdmissionStore,
  type ConnectOutcome,
  type LedgerPort,
  type PolicyView,
  type SettledOutcome,
  type SingleUseLedger,
  type TcpCheckProviderDeps,
} from "../src/security/tcpCheck/index.js";

const NOW = Date.parse("2026-11-20T00:00:00Z");

function makePolicy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    allowlist: { entries: [{ ip: "8.8.8.8", ports: [443] }] },
    snapshotDate: "2026-11-07T00:00:00Z",
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    policyEpoch: 1,
    ...overrides,
  };
}

function inMemoryAdmission(): AdmissionStore & { state: AdmissionState } {
  const store = {
    state: emptyAdmissionState(),
    get(): AdmissionState {
      return store.state;
    },
    put(_owner: string, next: AdmissionState): void {
      store.state = next;
    },
  };
  return store;
}

function inMemoryLedgerPort(): LedgerPort & { ledger: SingleUseLedger } {
  const port = {
    ledger: emptyLedger(),
    begin(claimKey: string, nowMs: number) {
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

function providerDeps(overrides: Partial<TcpCheckProviderDeps> = {}): TcpCheckProviderDeps {
  return {
    policy: () => makePolicy(),
    admission: inMemoryAdmission(),
    fence: { isActive: () => true },
    ledger: inMemoryLedgerPort(),
    clock: () => NOW,
    ...overrides,
  };
}

describe("tcpCheckArgumentsSchema", () => {
  it("accepts an ip + integer port and rejects extras / out-of-range ports", () => {
    assert.deepEqual(tcpCheckArgumentsSchema.parse({ ip: "8.8.8.8", port: 443 }), {
      ip: "8.8.8.8",
      port: 443,
    });
    assert.throws(() => tcpCheckArgumentsSchema.parse({ ip: "8.8.8.8", port: 0 }));
    assert.throws(() => tcpCheckArgumentsSchema.parse({ ip: "8.8.8.8", port: 70000 }));
    assert.throws(() => tcpCheckArgumentsSchema.parse({ ip: "8.8.8.8", port: 443, extra: 1 }));
  });
});

describe("tool definition — T3 + preflight gate", () => {
  const def = createTcpCheckToolDefinition(
    createTcpCheckProvider(providerDeps()),
    () => makePolicy(),
    () => NOW,
  );

  it("declares the governed external operation at T3", () => {
    assert.equal(def.tool, SECURITY_TOOL);
    assert.equal(def.operation, TCP_CHECK_OPERATION);
    assert.equal(def.minimumAuthority, "T3");
    assert.equal(def.externalProvider, TCP_CHECK_PROVIDER_NAME);
  });

  it("preflight passes an allowlisted canonical target and rejects the rest (no consumption)", async () => {
    await assert.doesNotReject(
      def.preflight!({ ip: "8.8.8.8", port: 443 }, new AbortController().signal),
    );
    for (const bad of [
      { ip: "08.8.8.8", port: 443 }, // non-canonical
      { ip: "127.0.0.1", port: 443 }, // special-use
      { ip: "9.9.9.9", port: 443 }, // not allowlisted
      { ip: "8.8.8.8", port: 80 }, // port not allowlisted
    ]) {
      await assert.rejects(def.preflight!(bad, new AbortController().signal));
    }
  });

  it("preflight rejects a stale snapshot", async () => {
    const stale = createTcpCheckToolDefinition(
      createTcpCheckProvider(providerDeps()),
      () => makePolicy({ maxAgeMs: 1 }),
      () => NOW,
    );
    await assert.rejects(
      stale.preflight!({ ip: "8.8.8.8", port: 443 }, new AbortController().signal),
    );
  });
});

describe("provider — fail-closed not-commissioned default", () => {
  it("prepares an attempt but the default connector never opens a socket", async () => {
    const provider = createTcpCheckProvider(providerDeps());
    const attempt = await provider.prepare(
      { ip: "8.8.8.8", port: 443 },
      { owner: "proj-1", project: "proj-1", actionFingerprint: "fp-1", correlationId: "corr-1" },
    );
    assert.equal(attempt.claim.target.ip, "8.8.8.8");
    const summary = await provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    // The not-commissioned connector throws -> enforcer reports an uncertain
    // effect, no signal, and the slot stays held (no time-based exit).
    assert.equal(summary.status, "effect_uncertain");
    assert.equal(summary.admissionSignal, null);
  });

  it("the default connector throws TcpCheckNotCommissionedError", async () => {
    const { notCommissionedConnector } = await import("../src/security/tcpCheck/index.js");
    await assert.rejects(
      notCommissionedConnector.connect({ ip: "8.8.8.8", port: 443 }, 5000),
      TcpCheckNotCommissionedError,
    );
  });

  it("createTcpCheckProviderFromEnv returns null (planned, not commissioned)", () => {
    assert.equal(createTcpCheckProviderFromEnv(), null);
  });
});

describe("provider — governed orchestration with an injected test connector", () => {
  function withConnector(outcome: ConnectOutcome): {
    deps: TcpCheckProviderDeps;
    admission: ReturnType<typeof inMemoryAdmission>;
    connectCalls: () => number;
  } {
    const admission = inMemoryAdmission();
    const state = { n: 0 };
    const deps = providerDeps({
      admission,
      connector: {
        async connect(): Promise<ConnectOutcome> {
          state.n += 1;
          return outcome;
        },
      },
    });
    return { deps, admission, connectCalls: () => state.n };
  }

  it("reserves the slot, connects once, releases it, and emits a digest-only summary", async () => {
    const { deps, admission, connectCalls } = withConnector("completed");
    const provider = createTcpCheckProvider(deps);
    const identity = {
      owner: "proj-1",
      project: "proj-1",
      actionFingerprint: "fp-1",
      correlationId: "corr-1",
    };
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, identity);
    // slot is held (started) between prepare and send
    assert.equal(admission.state.active?.phase, "started");

    const summary = await provider.sendPrepared(attempt, { ip: "8.8.8.8", port: 443 });
    assert.equal(summary.status, "completed");
    assert.equal(summary.admissionSignal, "socket-closed");
    assert.equal(summary.target, "8.8.8.8:443");
    assert.match(summary.allowlistDigest, /^[0-9a-f]{64}$/);
    // redaction: the summary carries only status/target/digest/signal
    assert.deepEqual(Object.keys(summary).sort(), [
      "admissionSignal",
      "allowlistDigest",
      "status",
      "target",
    ]);
    assert.equal(connectCalls(), 1);
    // slot released after a terminal signal
    assert.equal(admission.state.active, null);
  });

  it("refuses admission when the owner slot is already busy", async () => {
    const { deps } = withConnector("completed");
    const provider = createTcpCheckProvider(deps);
    const id = {
      owner: "proj-1",
      project: "proj-1",
      actionFingerprint: "fp-1",
      correlationId: "c",
    };
    await provider.prepare({ ip: "8.8.8.8", port: 443 }, id); // holds the slot
    await assert.rejects(
      provider.prepare({ ip: "8.8.8.8", port: 443 }, { ...id, actionFingerprint: "fp-2" }),
      /admission refused: slot-busy/,
    );
  });

  it("refuses a target the active policy does not permit, before reserving", async () => {
    const { deps } = withConnector("completed");
    const provider = createTcpCheckProvider(deps);
    await assert.rejects(
      provider.prepare(
        { ip: "9.9.9.9", port: 443 },
        { owner: "proj-1", project: "proj-1", actionFingerprint: "fp", correlationId: "c" },
      ),
      /not permitted/,
    );
  });
});

describe("enforcer wiring sanity — provider uses the same BrokerEnforcer contract", () => {
  it("BrokerEnforcer is constructible with the provider's port shapes", () => {
    const enforcer = new BrokerEnforcer({
      policy: () => makePolicy(),
      fence: { isActive: () => true },
      ledger: inMemoryLedgerPort(),
      connector: {
        async connect(): Promise<ConnectOutcome> {
          return "completed";
        },
      },
      clock: () => NOW,
    });
    assert.ok(enforcer instanceof BrokerEnforcer);
  });
});
