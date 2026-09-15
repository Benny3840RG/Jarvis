import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { getFunctionName } from "convex/server";

import type { HttpAppConfig } from "../src/http/config.js";
import { resolveHttpAppConfig } from "../src/http/config.js";
import type { OidcVerifier } from "../src/http/oidcVerifier.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import {
  CommissioningEvidenceLog,
  CommissioningIngressModule,
  CommissioningIngressRunner,
  commissioningAuthority,
  commissioningPolicyFingerprint,
  parseCommissioningIngressBody,
} from "../src/commissioning/isolatedIngress/index.js";
import { orchestrationRequestFingerprint } from "../src/orchestration/fingerprints.js";
import { setAuthenticatedPrincipal } from "../src/http/authenticatedPrincipal.js";
import type { DomainResult, OrchestrationExecutor } from "../src/orchestration/contracts.js";

const ISSUER = "https://issuer.example.com/";
const AUDIENCE = "jarvis-api";
const SUBJECT = "operator-subject";
const SERVICE_TOKEN = "commissioning-isolated-ingress-service-token-0";

function oidcConfig(subject = SUBJECT): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "development",
    deploymentVersion: null,
    authMode: "oidc",
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}jwks.json`,
      clockSkewSeconds: 30,
      subject,
    },
  };
}

function stubVerifier(behaviour: "ok" | "invalid" | "wrong-subject"): OidcVerifier {
  return {
    verify: async () => {
      if (behaviour === "invalid") throw new Error("bad token");
      return {
        subject: behaviour === "wrong-subject" ? "intruder-subject" : SUBJECT,
        issuer: ISSUER,
        audience: AUDIENCE,
      };
    },
  };
}

type RunDoc = Record<string, unknown> & { runId: string; state: string };

/**
 * An in-memory stand-in for the Convex orchestration state functions that
 * models the one property the drill turns on: `beginRun` is an atomic
 * check-and-insert on `(triggerSource, idempotencyKey)`, and each step takes
 * exactly one lease. The handler bodies run synchronously (no `await`), so
 * `Promise.all` over many ingress calls exercises the race the way the real
 * backend's serializable transactions would.
 */
class FakeOrchestrationBackend {
  private readonly runsByKey = new Map<string, RunDoc>();
  private readonly runsById = new Map<string, RunDoc>();
  private readonly steps = new Map<
    string,
    { runId: string; nodeId: string; state: string; attempt: number; leaseOwner?: string }
  >();

  beginRunCalls = 0;
  markStepRunningCalls = 0;
  executorCalls = 0;
  failBeginRun = false;
  hangBeginRun = false;
  beginBarrier?: Promise<void>;
  failTerminal = false;

  allRunIds(): string[] {
    return [...this.runsById.keys()];
  }

  private key(source: unknown, idempotencyKey: unknown): string {
    return `${String(source)} ${String(idempotencyKey)}`;
  }

  client(): ConvexClientLike {
    return {
      query: async () => null,
      mutation: async (ref: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
        if (name === "orchestrationState:beginRun") return this.beginRun(args);
        if (name === "orchestrationState:markStepRunning") return this.markStepRunning(args);
        if (name === "orchestrationState:recordStepSuccess")
          return this.recordTerminal(args, "succeeded");
        if (name === "orchestrationState:recordStepFailure")
          return this.recordTerminal(args, "failed");
        throw new Error(`Unexpected Convex mutation ${name}`);
      },
    } as ConvexClientLike;
  }

  private async beginRun(args: Record<string, unknown>): Promise<unknown> {
    this.beginRunCalls += 1;
    await this.beginBarrier;
    if (this.hangBeginRun) return new Promise(() => {});
    if (this.failBeginRun) throw new Error("Convex admission backend unavailable");
    const key = this.key(args.triggerSource, args.idempotencyKey);
    const existing = this.runsByKey.get(key);
    if (existing) {
      const same =
        existing.triggerKind === args.triggerKind &&
        existing.requestFingerprint === args.requestFingerprint &&
        existing.planFingerprint === args.planFingerprint &&
        existing.policyVersion === args.policyVersion &&
        existing.policyFingerprint === args.policyFingerprint;
      return { status: same ? "replayed" : "conflict", run: existing };
    }
    const run: RunDoc = {
      runId: String(args.runId),
      state: "queued",
      triggerKind: args.triggerKind,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: args.requestFingerprint,
      planFingerprint: args.planFingerprint,
      policyVersion: args.policyVersion,
      policyFingerprint: args.policyFingerprint,
      authority: args.authority,
      triggerPayload: args.triggerPayload,
    };
    this.runsByKey.set(key, run);
    this.runsById.set(run.runId, run);
    for (const nodeId of args.nodeIds as string[]) {
      this.steps.set(`${run.runId} ${nodeId}`, {
        runId: run.runId,
        nodeId,
        state: "pending",
        attempt: 0,
      });
    }
    return { status: "created", run };
  }

  private async markStepRunning(args: Record<string, unknown>): Promise<unknown> {
    this.markStepRunningCalls += 1;
    const step = this.steps.get(`${String(args.runId)} ${String(args.nodeId)}`);
    if (!step) throw new Error("Orchestration step not found.");
    if (step.state !== "pending")
      throw new Error(`Cannot transition step ${step.state} to running.`);
    step.state = "running";
    step.attempt += 1;
    step.leaseOwner = String(args.workerId);
    const run = this.runsById.get(String(args.runId));
    if (run) run.state = "running";
    return {
      step: { ...step, leaseOwner: step.leaseOwner },
      leaseToken: `lease-${step.runId}-${step.nodeId}-${step.attempt}`,
      fencingToken: step.attempt,
    };
  }

  private async recordTerminal(
    args: Record<string, unknown>,
    terminal: "succeeded" | "failed",
  ): Promise<unknown> {
    if (this.failTerminal) throw new Error("terminal transport failed");
    const step = this.steps.get(`${String(args.runId)} ${String(args.nodeId)}`);
    if (!step) throw new Error("Orchestration step not found.");
    step.state = terminal;
    step.leaseOwner = undefined;
    const run = this.runsById.get(String(args.runId));
    if (run) run.state = terminal;
    return {};
  }

  leaseOwnerFor(runId: string, nodeId: string): string | undefined {
    return this.steps.get(`${runId} ${nodeId}`)?.leaseOwner;
  }
}

function firstRunId(backend: FakeOrchestrationBackend): string {
  return backend.allRunIds()[0] as string;
}

function expectedWorkerId(): string {
  return `oidc:${createHash("sha256")
    .update(`${ISSUER}\0${AUDIENCE}\0${SUBJECT}`, "utf8")
    .digest("hex")}`;
}

async function buildApp(options: {
  verifier: OidcVerifier | null;
  runner: CommissioningIngressRunner;
  subject?: string;
}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    CommissioningIngressModule.register({
      config: oidcConfig(options.subject),
      oidcVerifier: options.verifier,
      runner: options.runner,
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function ingress(backend: FakeOrchestrationBackend, evidence: CommissioningEvidenceLog) {
  return new CommissioningIngressRunner({
    campaignId: "campaign-1",
    evidence,
    serviceToken: SERVICE_TOKEN,
    client: backend.client(),
    now: () => 1,
    admissionTimeoutMs: 200,
  });
}

const URL = "/commissioning/v1/isolated-ingress";
const AUTH = { authorization: "Bearer probe-token", "idempotency-key": "probe-key-123456" };

function authedRequest(): object {
  const request = {};
  setAuthenticatedPrincipal(request, { subject: SUBJECT, issuer: ISSUER, audience: AUDIENCE });
  return request;
}

describe("isolated-ingress commissioning — authentication", () => {
  it("rejects a missing, invalid or wrong-subject token before any admission call", async () => {
    const backend = new FakeOrchestrationBackend();
    const runner = ingress(backend, new CommissioningEvidenceLog());

    const noVerifier = await buildApp({ verifier: null, runner });
    assert.equal(
      (
        await noVerifier.inject({
          method: "POST",
          url: URL,
          headers: AUTH,
          payload: { nonce: "n" },
        })
      ).statusCode,
      503,
    );
    await noVerifier.close();

    const invalid = await buildApp({ verifier: stubVerifier("invalid"), runner });
    assert.equal(
      (
        await invalid.inject({
          method: "POST",
          url: URL,
          headers: { "idempotency-key": AUTH["idempotency-key"] },
          payload: { nonce: "n" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await invalid.inject({ method: "POST", url: URL, headers: AUTH, payload: { nonce: "n" } }))
        .statusCode,
      401,
    );
    await invalid.close();

    const wrong = await buildApp({ verifier: stubVerifier("wrong-subject"), runner });
    assert.equal(
      (await wrong.inject({ method: "POST", url: URL, headers: AUTH, payload: { nonce: "n" } }))
        .statusCode,
      403,
    );
    await wrong.close();

    assert.equal(backend.beginRunCalls, 0, "no admission call for a rejected identity");
  });
});

describe("isolated-ingress commissioning — forged authority", () => {
  it("rejects an authority field in the body and always admits with policy authority", async () => {
    assert.throws(
      () => parseCommissioningIngressBody({ nonce: "n", authority: "T3" }),
      /unsupported field "authority"/,
    );

    const backend = new FakeOrchestrationBackend();
    const app = await buildApp({
      verifier: stubVerifier("ok"),
      runner: ingress(backend, new CommissioningEvidenceLog()),
    });
    const response = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: { nonce: "authority-probe" },
    });
    assert.equal(response.statusCode, 201);
    await app.close();
    assert.equal(commissioningAuthority(), "T1");
  });
});

describe("isolated-ingress commissioning — fingerprint semantics", () => {
  it("replays a key-order / whitespace change and conflicts on a semantic change", async () => {
    const a = orchestrationRequestFingerprint(
      parseCommissioningIngressBody({ nonce: "x", payload: { a: 1, b: 2 } }),
    );
    const reordered = orchestrationRequestFingerprint(
      parseCommissioningIngressBody({ payload: { b: 2, a: 1 }, nonce: "x" }),
    );
    const changed = orchestrationRequestFingerprint(
      parseCommissioningIngressBody({ nonce: "x", payload: { a: 1, b: 3 } }),
    );
    assert.equal(a.fingerprint, reordered.fingerprint);
    assert.notEqual(a.fingerprint, changed.fingerprint);

    const backend = new FakeOrchestrationBackend();
    const runner = ingress(backend, new CommissioningEvidenceLog());
    const request = authedRequest();

    const created = await runner.admit(
      request,
      parseCommissioningIngressBody({ nonce: "fp", payload: { site: "north" } }),
      "fp-key-000002",
      "first-attempt",
    );
    assert.equal(created.disposition, "created-complete");

    const replay = await runner.admit(
      request,
      parseCommissioningIngressBody({ payload: { site: "north" }, nonce: "fp" }),
      "fp-key-000002",
      "first-attempt",
    );
    assert.equal(replay.disposition, "terminal-replay");
    assert.equal(replay.status, 200);

    const conflict = await runner.admit(
      request,
      parseCommissioningIngressBody({ nonce: "fp", payload: { site: "south" } }),
      "fp-key-000002",
      "first-attempt",
    );
    assert.equal(conflict.disposition, "conflict");
    assert.equal(conflict.status, 409);
  });
});

describe("isolated-ingress commissioning — delivery race", () => {
  it("admits exactly one creation and one executor entry; the rest replay", async () => {
    const backend = new FakeOrchestrationBackend();
    const evidence = new CommissioningEvidenceLog();
    const runner = ingress(backend, evidence);
    const request = authedRequest();

    const body = parseCommissioningIngressBody({ nonce: "race", payload: { drill: true } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runner.admit(request, body, "race-key-000001", "first-attempt"),
      ),
    );

    const created = results.filter((r) => r.disposition === "created-complete");
    const replays = results.filter(
      (r) => r.disposition === "terminal-replay" || r.disposition === "nonterminal-replay",
    );
    assert.equal(created.length, 1);
    assert.equal(replays.length, 19);
    assert.equal(backend.markStepRunningCalls, 1, "one lease, one execution");

    const canonicalRunId = created[0]?.runId;
    assert.ok(canonicalRunId);
    for (const result of results) assert.equal(result.runId, canonicalRunId);

    const tally = evidence.tally();
    assert.equal(tally.creations, 1);
    assert.equal(tally.deliveries, 20);
    assert.equal(tally.firstAttempt, 20);
    assert.equal(tally.transientFailures, 0);
  });
});

describe("isolated-ingress commissioning — backend unavailable & timeout", () => {
  it("returns 503 without executing and without minting a fresh key", async () => {
    const backend = new FakeOrchestrationBackend();
    backend.failBeginRun = true;
    const app = await buildApp({
      verifier: stubVerifier("ok"),
      runner: ingress(backend, new CommissioningEvidenceLog()),
    });
    const response = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: { nonce: "down" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(backend.markStepRunningCalls, 0);
    await app.close();
  });

  it("treats a stalled admission as an unknown outcome (503), never local execution", async () => {
    const backend = new FakeOrchestrationBackend();
    backend.hangBeginRun = true;
    const evidence = new CommissioningEvidenceLog();
    const outcome = await ingress(backend, evidence).admit(
      authedRequest(),
      parseCommissioningIngressBody({ nonce: "stall" }),
      "stall-key-01",
      "first-attempt",
    );
    assert.equal(outcome.disposition, "admission-unknown");
    assert.equal(outcome.status, 503);
    assert.equal(backend.markStepRunningCalls, 0);
    assert.equal(evidence.tally().transientFailures, 1);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function barrierExecutor(reached: () => void, held: Promise<void>): OrchestrationExecutor {
  return {
    async execute(): Promise<DomainResult> {
      reached();
      await held;
      return { ok: true, value: { probe: "ok", nonce: "lease", observedAt: 1 } };
    },
  };
}

describe("isolated-ingress commissioning — lease identity evidence", () => {
  it("holds the executor at a barrier and shows the lease bound to the OIDC worker id", async () => {
    const backend = new FakeOrchestrationBackend();
    const evidence = new CommissioningEvidenceLog();
    const atBarrier = deferred();
    const releaseBarrier = deferred();

    const runner = new CommissioningIngressRunner({
      campaignId: "campaign-1",
      evidence,
      serviceToken: SERVICE_TOKEN,
      client: backend.client(),
      now: () => 1,
      admissionTimeoutMs: 5_000,
      probeExecutor: barrierExecutor(atBarrier.resolve, releaseBarrier.promise),
    });

    const admitting = runner.admit(
      authedRequest(),
      parseCommissioningIngressBody({ nonce: "lease" }),
      "lease-key-000001",
      "first-attempt",
    );

    await atBarrier.promise;
    // The step is running; the durable lease is held by the derived worker id.
    assert.equal(backend.markStepRunningCalls, 1);
    assert.equal(backend.leaseOwnerFor(firstRunId(backend), "probe"), expectedWorkerId());

    releaseBarrier.resolve();
    const outcome = await admitting;
    assert.equal(outcome.disposition, "created-complete");

    const delivery = evidence.snapshot().find((e) => e.kind === "delivery");
    assert.equal(delivery?.kind === "delivery" ? delivery.workerId : "", expectedWorkerId());
    assert.match(
      delivery?.kind === "delivery" ? delivery.preImage : "",
      /"nonce":"lease"/,
      "canonical pre-image retained",
    );
  });
});

describe("isolated-ingress commissioning — bootstrap config", () => {
  it("forces authMode oidc without changing resolveHttpAppConfig", () => {
    const env = {
      JARVIS_HTTP_HOST: "127.0.0.1",
      JARVIS_HTTP_PORT: "4599",
      JARVIS_OIDC_ISSUER: ISSUER,
      JARVIS_OIDC_AUDIENCE: AUDIENCE,
      JARVIS_OIDC_JWKS_URL: `${ISSUER}jwks.json`,
      JARVIS_OIDC_SUBJECT: SUBJECT,
      JARVIS_SERVICE_TOKEN: SERVICE_TOKEN,
      CONVEX_URL: "https://example.convex.cloud",
      CONVEX_DEPLOYMENT: "dev:example",
    } as NodeJS.ProcessEnv;

    // The production resolver still reports service-token on a loopback host.
    assert.equal(resolveHttpAppConfig(env).authMode, "service-token");

    // The bootstrap resolver forces oidc and keeps the loopback host.
    // (imported lazily to avoid a Nest import at module load for a pure check)
    return import("../src/commissioning/isolatedIngress/bootstrap.js").then(
      ({ resolveCommissioningBootstrapConfig }) => {
        const resolved = resolveCommissioningBootstrapConfig(env);
        for (const target of [
          { CONVEX_DEPLOYMENT: undefined },
          { CONVEX_DEPLOYMENT: "prod:example" },
          { CONVEX_URL: "https://other.convex.cloud" },
          { CONVEX_URL: "https://example.convex.cloud/?x=1" },
        ])
          assert.throws(
            () => resolveCommissioningBootstrapConfig({ ...env, ...target }),
            /development|dev:/i,
          );
        assert.equal(resolved.config.authMode, "oidc");
        assert.equal(resolved.host, "127.0.0.1");
        assert.equal(resolved.config.oidc.subject, SUBJECT);
        assert.throws(
          () => resolveCommissioningBootstrapConfig({ ...env, JARVIS_HTTP_HOST: "0.0.0.0" }),
          /loopback/,
        );
      },
    );
  });

  it("keeps commissioningProbe off the public capability surface", async () => {
    const { IMPLEMENTED_CAPABILITIES } = await import("../src/http/contracts.js");
    assert.ok(
      !IMPLEMENTED_CAPABILITIES.some(
        (capability) => capability.operationId === "commissioningProbe",
      ),
    );
    assert.ok(commissioningPolicyFingerprint().startsWith("commissioning-policy:v1:sha256:"));
  });
});

describe("commissioning review regressions", () => {
  it("retains special JSON keys in both parsed bodies and fingerprints", () => {
    const a = JSON.parse('{"nonce":"n","payload":{"__proto__":"a","constructor":true}}');
    const b = JSON.parse('{"nonce":"n","payload":{"__proto__":"b","constructor":true}}');
    const parsed = parseCommissioningIngressBody(a);
    assert.equal(Object.hasOwn(parsed.payload, "__proto__"), true);
    assert.equal(parsed.payload["__proto__"], "a");
    assert.notEqual(
      orchestrationRequestFingerprint(a).fingerprint,
      orchestrationRequestFingerprint(b).fingerprint,
    );
    assert.notEqual(
      orchestrationRequestFingerprint(parsed).fingerprint,
      orchestrationRequestFingerprint(parseCommissioningIngressBody(b)).fingerprint,
    );
  });

  it("never starts a step after a timed-out beginRun later creates the run", async () => {
    const backend = new FakeOrchestrationBackend();
    const gate = deferred();
    backend.beginBarrier = gate.promise;
    const result = await ingress(backend, new CommissioningEvidenceLog()).admit(
      authedRequest(),
      parseCommissioningIngressBody({ nonce: "late" }),
      "late-key-123",
      "first-attempt",
    );
    assert.equal(result.status, 503);
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(backend.allRunIds().length, 1);
    assert.equal(backend.markStepRunningCalls, 0);
  });

  it("does not claim no execution when completion transport fails", async () => {
    const backend = new FakeOrchestrationBackend();
    backend.failTerminal = true;
    const result = await ingress(backend, new CommissioningEvidenceLog()).admit(
      authedRequest(),
      parseCommissioningIngressBody({ nonce: "done" }),
      "done-key-123",
      "first-attempt",
    );
    assert.equal(backend.markStepRunningCalls, 1);
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.detail, /no execution occurred/);
    assert.match(result.detail, /unknown/);
  });

  it("caps lifetime admission before backend effects while retaining all admitted evidence", async () => {
    const backend = new FakeOrchestrationBackend();
    const evidence = new CommissioningEvidenceLog(undefined, undefined, 2);
    const runner = ingress(backend, evidence);
    for (let i = 0; i < 2; i++)
      await runner.admit(
        authedRequest(),
        parseCommissioningIngressBody({ nonce: "cap" }),
        `cap-key-${i}`,
        "first-attempt",
      );
    await assert.rejects(
      runner.admit(
        authedRequest(),
        parseCommissioningIngressBody({ nonce: "cap" }),
        "cap-key-3",
        "first-attempt",
      ),
      /evidence capacity/i,
    );
    assert.equal(backend.beginRunCalls, 2);
    assert.equal(evidence.tally().deliveries, 2);
    assert.equal(evidence.tally().stepOutcomes, 2);
    assert.equal(evidence.snapshot().length, 4);
  });

  it("rejects missing, production and mismatched cleanup targets before effects", async () => {
    const { purgeCommissioningRuns } =
      await import("../src/commissioning/isolatedIngress/cleanup.js");
    let calls = 0;
    const client = {
      query: async () => null,
      mutation: async () => {
        calls++;
        return {};
      },
    } as ConvexClientLike;
    for (const env of [
      {},
      { CONVEX_DEPLOYMENT: "prod:example", CONVEX_URL: "https://example.convex.cloud" },
      { CONVEX_DEPLOYMENT: "dev:example", CONVEX_URL: "https://other.convex.cloud" },
    ]) {
      await assert.rejects(
        purgeCommissioningRuns(
          { client, serviceToken: SERVICE_TOKEN, env },
          { campaignId: "c", runIds: ["r"] },
        ),
        /development|dev:/i,
      );
    }
    assert.equal(calls, 0);
  });
});

it("reports unknown while a probe already executing at timeout can finish", async () => {
  const backend = new FakeOrchestrationBackend();
  const evidence = new CommissioningEvidenceLog();
  const entered = deferred();
  const release = deferred();
  const runner = new CommissioningIngressRunner({
    campaignId: "c",
    evidence,
    serviceToken: SERVICE_TOKEN,
    client: backend.client(),
    admissionTimeoutMs: 200,
    probeExecutor: barrierExecutor(entered.resolve, release.promise),
  });
  const resultPromise = runner.admit(
    authedRequest(),
    parseCommissioningIngressBody({ nonce: "lease" }),
    "timeout-executing-key",
    "first-attempt",
  );
  await entered.promise;
  const result = await resultPromise;
  assert.equal(result.status, 503);
  assert.match(result.detail, /unknown/);
  release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(evidence.tally().stepOutcomes, 1);
  assert.equal(evidence.tally().creations, 0);
  assert.equal(evidence.tally().transientFailures, 1);
});
