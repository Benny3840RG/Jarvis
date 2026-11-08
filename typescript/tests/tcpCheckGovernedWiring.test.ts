import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TCP_CHECK_OPERATION,
  SECURITY_TOOL,
  TCP_CHECK_PROVIDER_NAME,
  TcpCheckNotCommissionedError,
  beginConsume,
  computeAllowlistDigest,
  createInMemoryAdmissionStore,
  createTcpCheckProvider,
  createTcpCheckProviderFromEnv,
  createTcpCheckToolDefinition,
  emptyLedger,
  finalizeConsume,
  tcpCheckArgumentsSchema,
  type ConnectOutcome,
  type LedgerPort,
  type PolicyView,
  type SettledOutcome,
  type SingleUseLedger,
  type TcpCheckProviderDeps,
} from "../src/security/tcpCheck/index.js";

const ALLOWLIST = { entries: [{ ip: "8.8.8.8", ports: [443] }] } as const;
const NOW = Date.parse("2026-11-20T00:00:00Z");

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
    admission: createInMemoryAdmissionStore(),
    fence: { isActive: () => true },
    ledger: inMemoryLedgerPort(),
    clock: () => NOW,
    ...overrides,
  };
}

const APPROVED = computeAllowlistDigest(ALLOWLIST);

const IDENTITY = {
  owner: "owner-1",
  project: "proj-1",
  actionFingerprint: "fp-1",
  approvedAllowlistDigest: APPROVED,
  correlationId: "c",
};

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

  it("does not trim a whitespace-padded ip (reject, never rewrite)", () => {
    assert.equal(tcpCheckArgumentsSchema.parse({ ip: " 8.8.8.8 ", port: 443 }).ip, " 8.8.8.8 ");
  });
});

describe("tool definition — T3 + preflight gate", () => {
  const def = createTcpCheckToolDefinition(
    createTcpCheckProvider(providerDeps()),
    () => makePolicy(),
    (action) => action.projectId,
    () => APPROVED,
    () => NOW,
  );

  it("declares the governed external operation at T3", () => {
    assert.equal(def.tool, SECURITY_TOOL);
    assert.equal(def.operation, TCP_CHECK_OPERATION);
    assert.equal(def.minimumAuthority, "T3");
    assert.equal(def.externalProvider, TCP_CHECK_PROVIDER_NAME);
  });

  it("preflight passes an allowlisted canonical target and rejects the rest", async () => {
    await assert.doesNotReject(
      def.preflight!({ ip: "8.8.8.8", port: 443 }, new AbortController().signal),
    );
    for (const bad of [
      { ip: "08.8.8.8", port: 443 },
      { ip: "127.0.0.1", port: 443 },
      { ip: "224.0.0.1", port: 443 }, // multicast (Codex #6)
      { ip: "9.9.9.9", port: 443 },
      { ip: "8.8.8.8", port: 80 },
      { ip: " 8.8.8.8 ", port: 443 },
    ]) {
      await assert.rejects(def.preflight!(bad, new AbortController().signal));
    }
  });
});

describe("provider — fail-closed not-commissioned default", () => {
  it("prepares an attempt but the default connector holds the slot as uncertain", async () => {
    const deps = providerDeps();
    const provider = createTcpCheckProvider(deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, IDENTITY);
    assert.match(attempt.claim.approvedAllowlistDigest, /^[0-9a-f]{64}$/);
    const summary = await provider.sendPrepared(attempt);
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

describe("provider — governed orchestration", () => {
  function withConnector(outcome: ConnectOutcome): {
    deps: TcpCheckProviderDeps;
    admission: ReturnType<typeof createInMemoryAdmissionStore>;
    connectCalls: () => number;
  } {
    const admission = createInMemoryAdmissionStore();
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

  it("reserves, connects once, releases the slot, and emits a claim-derived summary", async () => {
    const { deps, admission, connectCalls } = withConnector("connected");
    const provider = createTcpCheckProvider(deps);
    const attempt = await provider.prepare({ ip: "8.8.8.8", port: 443 }, IDENTITY);
    // Reserved (not started): budget is charged only at the started flip.
    assert.equal(admission.snapshot("owner-1").active?.phase, "reserved");

    const summary = await provider.sendPrepared(attempt);
    assert.equal(summary.status, "connected");
    assert.equal(summary.admissionSignal, "socket-closed");
    assert.equal(summary.target, "8.8.8.8:443");
    assert.equal(summary.allowlistDigest, computeAllowlistDigest(ALLOWLIST));
    assert.deepEqual(Object.keys(summary).sort(), [
      "admissionSignal",
      "allowlistDigest",
      "status",
      "target",
    ]);
    assert.equal(connectCalls(), 1);
    assert.equal(admission.snapshot("owner-1").active, null);
  });

  it("refuses admission when the owner slot is already busy", async () => {
    const { deps } = withConnector("connected");
    const provider = createTcpCheckProvider(deps);
    await provider.prepare({ ip: "8.8.8.8", port: 443 }, IDENTITY);
    await assert.rejects(
      provider.prepare({ ip: "8.8.8.8", port: 443 }, { ...IDENTITY, actionFingerprint: "fp-2" }),
      /admission refused: slot-busy/,
    );
  });

  it("refuses a target the active policy does not permit, before reserving", async () => {
    const { deps, admission } = withConnector("connected");
    const provider = createTcpCheckProvider(deps);
    await assert.rejects(provider.prepare({ ip: "9.9.9.9", port: 443 }, IDENTITY), /not permitted/);
    assert.equal(admission.snapshot("owner-1").active, null); // nothing reserved
  });
});

describe("tool execute — owner resolution (Codex #5) and signal propagation (Codex #7)", () => {
  function fakeContext(overrides: Record<string, unknown> = {}): never {
    const recorded: unknown[] = [];
    return {
      action: { projectId: "proj-1", actionId: "act-123" },
      idempotencyKey: "idem",
      actionFingerprint: "af",
      effectFingerprint: "ef",
      correlationId: "corr",
      source: "test",
      policyVersion: "v1",
      registerProviderAttempt: async (r: unknown) => {
        recorded.push(r);
      },
      ...overrides,
    } as never;
  }

  it("keys admission on the resolved owner, not the project id", async () => {
    const admission = createInMemoryAdmissionStore();
    const deps = providerDeps({
      admission,
      connector: {
        async connect(): Promise<ConnectOutcome> {
          return "connected";
        },
      },
    });
    const provider = createTcpCheckProvider(deps);
    const def = createTcpCheckToolDefinition(
      provider,
      () => makePolicy(),
      () => "authenticated-owner",
      () => APPROVED,
      () => NOW,
    );
    await def.execute({ ip: "8.8.8.8", port: 443 }, new AbortController().signal, fakeContext());
    // The slot bucket is the resolved owner, not "proj-1".
    assert.equal(admission.snapshot("authenticated-owner").active, null); // released after connect
    assert.equal(admission.snapshot("proj-1").active, null); // never used
  });

  it("propagates an aborted signal so no socket opens", async () => {
    let connects = 0;
    const deps = providerDeps({
      connector: {
        async connect(): Promise<ConnectOutcome> {
          connects += 1;
          return "connected";
        },
      },
    });
    const def = createTcpCheckToolDefinition(
      createTcpCheckProvider(deps),
      () => makePolicy(),
      (action) => action.projectId,
      () => APPROVED,
      () => NOW,
    );
    const controller = new AbortController();
    controller.abort();
    const result = (await def.execute(
      { ip: "8.8.8.8", port: 443 },
      controller.signal,
      fakeContext(),
    )) as { status: string };
    assert.equal(result.status, "cancelled");
    assert.equal(connects, 0);
  });
});
