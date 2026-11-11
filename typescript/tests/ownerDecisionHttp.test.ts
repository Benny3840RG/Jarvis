import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { OidcVerifier } from "../src/http/oidcVerifier.js";
import { parseOwnerDecisionManifest } from "../src/ownerGate/ownerDecision.js";
import {
  InMemoryOwnerDecisionLedger,
  OwnerDecisionService,
} from "../src/ownerGate/ownerDecisionService.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";

const SERVICE = "owner-queue-service-token";
const APPROVAL = "owner-queue-approval-token";
const AUTH = { authorization: `Bearer ${SERVICE}` };
const openApps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in owner decision tests");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const MANIFEST = parseOwnerDecisionManifest({
  version: 1,
  repository: "example/repo",
  excluded: [{ issue: 9, reason: "Parked." }],
  decisions: [
    {
      id: "standard",
      title: "A standard decision",
      issues: [1],
      proposedAction: "Accept the evidence.",
      consequence: "The gate closes.",
      scope: "Development only.",
      environment: "development",
      risk: "standard",
      subjects: [{ kind: "issue", number: 1, revision: "2026-11-01T00:00:00Z" }],
      dependsOn: [],
      evidence: [{ label: "Issue", url: "https://github.com/example/repo/issues/1" }],
      missingPrerequisites: [],
      rollback: "Reopen the issue.",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
    {
      id: "exposure",
      title: "A high-risk decision",
      issues: [2],
      proposedAction: "Expose the service.",
      consequence: "It becomes reachable.",
      scope: "One hostname.",
      environment: "production",
      risk: "high",
      highRiskKind: "remote-exposure",
      subjects: [{ kind: "pull-request", number: 2, revision: "b".repeat(40) }],
      dependsOn: [],
      evidence: [],
      missingPrerequisites: [],
      rollback: "Rebind to loopback.",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
    {
      id: "blocked",
      title: "A decision without evidence",
      issues: [3],
      proposedAction: "Release.",
      consequence: "It is released.",
      scope: "Everything.",
      environment: "development",
      risk: "standard",
      subjects: [{ kind: "branch", name: "main", revision: "c".repeat(40) }],
      dependsOn: [],
      evidence: [],
      missingPrerequisites: ["No evidence run exists."],
      rollback: "Roll back.",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  ],
});

type World = {
  host?: string;
  approvalToken?: string | undefined;
  oidcVerifier?: OidcVerifier;
  config?: Partial<HttpAppConfig>;
  ledgerStarted?: boolean;
  /** What the live check reports for every subject; default: unchanged. */
  liveRevision?: string | null;
};

async function open(world: World = {}) {
  const config: HttpAppConfig = {
    version: "0.1.0",
    sourceVersion: "owner-decision-http-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: SERVICE,
    previousToken: undefined,
    ...("approvalToken" in world
      ? world.approvalToken === undefined
        ? {}
        : { currentApprovalToken: world.approvalToken }
      : { currentApprovalToken: APPROVAL }),
    ...world.config,
  };
  const ledger = new InMemoryOwnerDecisionLedger({ started: world.ledgerStarted ?? true });
  const app = await createJarvisHttpApp({
    config,
    credentialsRuntime: captureCredentials({
      serviceToken: SERVICE,
      httpHost: world.host ?? "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    persistence: unusedPersistence(),
    providerName: "json",
    logger: false,
    ...(world.oidcVerifier === undefined ? {} : { oidcVerifier: world.oidcVerifier }),
    ownerDecisions: new OwnerDecisionService({
      manifest: MANIFEST,
      ledger,
      approvalConfigured: () => config.currentApprovalToken !== undefined,
      subjectProbe: async (subject) =>
        world.liveRevision === undefined ? subject.revision : world.liveRevision,
    }),
  });
  openApps.push(app);
  return { app, ledger };
}

type Card = {
  entry: { id: string };
  actionDigest: string;
  status: string;
  confirmationPhrase?: string;
  blockedBy: string[];
  decision?: { actor: string };
};

async function cards(app: NestFastifyApplication): Promise<Record<string, Card>> {
  const response = await app.inject({ method: "GET", url: "/api/v1/owner-decisions" });
  assert.equal(response.statusCode, 200);
  const list = (response.json() as { data: { cards: Card[] } }).data.cards;
  return Object.fromEntries(list.map((card) => [card.entry.id, card]));
}

let counter = 0;
function click(
  app: NestFastifyApplication,
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = AUTH,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/owner-decisions/${id}/decisions`,
    headers,
    payload: {
      idempotencyKey: `http-test-key-${(counter += 1)}`,
      approvalToken: APPROVAL,
      ...body,
    },
  });
}

describe("owner decision queue HTTP", () => {
  it("serves a token-free page and a read-only queue on loopback", async () => {
    const { app } = await open();
    const page = await app.inject({ method: "GET", url: "/settings/owner-decisions" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(page.headers["cache-control"], "no-store");
    for (const secret of [SERVICE, APPROVAL, "A standard decision"]) {
      assert.equal(page.body.includes(secret), false);
    }
    assert.equal(page.body.includes("localStorage"), false);
    assert.equal(page.body.includes("sessionStorage"), false);
    assert.equal(page.body.includes("innerHTML"), false);

    const queue = await app.inject({ method: "GET", url: "/api/v1/owner-decisions" });
    assert.equal(queue.statusCode, 200);
    const data = (queue.json() as { data: { decisionsAvailable: boolean; cards: Card[] } }).data;
    assert.equal(data.decisionsAvailable, true);
    assert.deepEqual(
      data.cards.map((card) => card.status),
      ["READY", "READY", "NOT_READY"],
    );
    assert.equal(queue.body.includes(APPROVAL), false);
  });

  it("serves neither the page nor an anonymous queue off loopback", async () => {
    const { app } = await open({ host: "0.0.0.0" });
    assert.equal(
      (await app.inject({ method: "GET", url: "/settings/owner-decisions" })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/v1/owner-decisions" })).statusCode,
      401,
    );
    const authed = await app.inject({
      method: "GET",
      url: "/api/v1/owner-decisions",
      headers: AUTH,
    });
    assert.equal(authed.statusCode, 200);
  });

  it("refuses unauthenticated and wrong-token clicks even on loopback", async () => {
    const { app, ledger } = await open();
    const { standard } = await cards(app);
    const body = { expectedDigest: standard!.actionDigest, decision: "approve" };
    assert.equal((await click(app, "standard", body, {})).statusCode, 401);
    assert.equal(
      (await click(app, "standard", body, { authorization: "Bearer wrong" })).statusCode,
      401,
    );
    assert.deepEqual(await ledger.read(), []);
  });

  it("refuses a forged owner: a valid service token without the approval token", async () => {
    const { app, ledger } = await open();
    const { standard } = await cards(app);
    const body = { expectedDigest: standard!.actionDigest, decision: "approve" };
    const forged = await click(app, "standard", { ...body, approvalToken: SERVICE });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.body.includes(APPROVAL), false);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/owner-decisions/standard/decisions",
      headers: AUTH,
      payload: { ...body, idempotencyKey: "http-test-missing-token" },
    });
    assert.equal(missing.statusCode, 422);
    assert.deepEqual(await ledger.read(), []);
  });

  it("refuses an OIDC token for a subject that is not the owner", async () => {
    const verifier: OidcVerifier = {
      async verify(token: string) {
        if (token === "owner-token" || token === "stranger-token") {
          return {
            subject: token === "owner-token" ? "owner-sub" : "stranger-sub",
            issuer: "https://issuer.example",
            audience: "jarvis",
          };
        }
        throw new Error("invalid");
      },
    } as OidcVerifier;
    const { app, ledger } = await open({
      oidcVerifier: verifier,
      config: {
        authMode: "oidc",
        oidc: {
          issuer: "https://issuer.example",
          audience: "jarvis",
          jwksUrl: "https://issuer.example/jwks",
          subject: "owner-sub",
        },
      } as Partial<HttpAppConfig>,
    });
    const queue = await app.inject({
      method: "GET",
      url: "/api/v1/owner-decisions",
      headers: { authorization: "Bearer owner-token" },
    });
    const standard = (queue.json() as { data: { cards: Card[] } }).data.cards[0]!;
    const body = { expectedDigest: standard.actionDigest, decision: "approve" };
    const stranger = await click(app, "standard", body, {
      authorization: "Bearer stranger-token",
    });
    assert.equal(stranger.statusCode, 403);
    assert.deepEqual(await ledger.read(), []);
    const owner = await click(app, "standard", body, { authorization: "Bearer owner-token" });
    assert.equal(owner.statusCode, 200);
    assert.equal((await ledger.read())[0]!.actor, "oidc:owner-sub");
  });

  it("records one click, replays a double click and refuses a second decision", async () => {
    const { app, ledger } = await open();
    const { standard } = await cards(app);
    const payload = {
      expectedDigest: standard!.actionDigest,
      decision: "approve",
      idempotencyKey: "http-test-double-click",
      approvalToken: APPROVAL,
      note: "Looks right.",
    };
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/owner-decisions/standard/decisions",
        headers: AUTH,
        payload,
      });
    const [first, second] = await Promise.all([send(), send()]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const results = [first, second].map(
      (response) =>
        (response.json() as { data: { recordId: string; replayed: boolean; card: Card } }).data,
    );
    assert.equal(results[0]!.recordId, results[1]!.recordId);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(results[0]!.card.status, "APPROVED");
    assert.equal(first.body.includes(APPROVAL), false);
    assert.equal((await ledger.read()).length, 1);

    const again = await click(app, "standard", {
      expectedDigest: standard!.actionDigest,
      decision: "approve",
    });
    assert.equal(again.statusCode, 409);
    assert.match(again.body, /owner-decision-already-decided/);
    assert.equal((await ledger.read()).length, 1);
  });

  it("refuses a stale digest, a card without evidence and an unknown card", async () => {
    const { app, ledger } = await open();
    const { standard, blocked } = await cards(app);
    const stale = await click(app, "standard", {
      expectedDigest: "0".repeat(64),
      decision: "approve",
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.body, /owner-decision-stale/);
    const notReady = await click(app, "blocked", {
      expectedDigest: blocked!.actionDigest,
      decision: "approve",
    });
    assert.equal(notReady.statusCode, 409);
    assert.match(notReady.body, /No evidence run exists/);
    const unknown = await click(app, "nope", {
      expectedDigest: standard!.actionDigest,
      decision: "approve",
    });
    assert.equal(unknown.statusCode, 404);
    for (const body of [
      { expectedDigest: "short", decision: "approve" },
      { expectedDigest: standard!.actionDigest, decision: "approve-all" },
      { expectedDigest: standard!.actionDigest, decision: "approve", all: true },
    ]) {
      assert.equal((await click(app, "standard", body)).statusCode, 422);
    }
    assert.deepEqual(await ledger.read(), []);
  });

  it("needs a separate typed confirmation for a high-risk card", async () => {
    const { app, ledger } = await open();
    const { exposure } = await cards(app);
    assert.equal(exposure!.confirmationPhrase, "APPROVE exposure");
    const body = { expectedDigest: exposure!.actionDigest, decision: "approve" };
    const bare = await click(app, "exposure", body);
    assert.equal(bare.statusCode, 422);
    assert.match(bare.body, /owner-decision-confirmation-required/);
    assert.equal(
      (await click(app, "exposure", { ...body, confirmation: "APPROVE standard" })).statusCode,
      422,
    );
    assert.deepEqual(await ledger.read(), []);
    const confirmed = await click(app, "exposure", { ...body, confirmation: "APPROVE exposure" });
    assert.equal(confirmed.statusCode, 200);
  });

  it("is read-only when the approval token is not configured", async () => {
    const { app, ledger } = await open({ approvalToken: undefined });
    const queue = await app.inject({ method: "GET", url: "/api/v1/owner-decisions" });
    const data = (
      queue.json() as {
        data: { decisionsAvailable: boolean; unavailableReason: string; cards: Card[] };
      }
    ).data;
    assert.equal(data.decisionsAvailable, false);
    assert.match(data.unavailableReason, /read-only/);
    assert.equal(data.cards.length, 3);
    const refused = await click(app, "standard", {
      expectedDigest: data.cards[0]!.actionDigest,
      decision: "approve",
    });
    assert.equal(refused.statusCode, 503);
    const report = await app.inject({
      method: "POST",
      url: "/api/v1/owner-decisions/standard/executions",
      headers: AUTH,
      payload: {
        expectedDigest: data.cards[0]!.actionDigest,
        status: "executed",
        idempotencyKey: "http-test-readonly-exec",
      },
    });
    assert.equal(report.statusCode, 503);
    assert.deepEqual(await ledger.read(), []);
  });

  it("refuses an approval when a subject moved or cannot be checked", async () => {
    for (const [liveRevision, slug, status] of [
      ["2026-11-09T00:00:00Z", "owner-decision-subject-changed", 409],
      [null, "owner-decision-unavailable", 503],
    ] as const) {
      const { app, ledger } = await open({ liveRevision });
      const { standard } = await cards(app);
      const refused = await click(app, "standard", {
        expectedDigest: standard!.actionDigest,
        decision: "approve",
      });
      assert.equal(refused.statusCode, status);
      assert.match(refused.body, new RegExp(slug));
      assert.deepEqual(await ledger.read(), []);
    }
  });

  it("starts a ledger only on purpose, with the approval token, and only once", async () => {
    const { app } = await open({ ledgerStarted: false });
    const before = await app.inject({ method: "GET", url: "/api/v1/owner-decisions" });
    const data = (
      before.json() as { data: { ledgerState: string; decisionsAvailable: boolean; cards: Card[] } }
    ).data;
    assert.equal(data.ledgerState, "not-started");
    assert.equal(data.decisionsAvailable, false);
    const refused = await click(app, "standard", {
      expectedDigest: data.cards[0]!.actionDigest,
      decision: "reject",
    });
    assert.equal(refused.statusCode, 503);

    const start = (payload: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
      app.inject({ method: "POST", url: "/api/v1/owner-decisions/ledger", headers, payload });
    const good = { approvalToken: APPROVAL, confirmation: "START NEW LEDGER" };
    assert.equal((await start(good, {})).statusCode, 401);
    assert.equal((await start({ ...good, approvalToken: SERVICE })).statusCode, 403);
    assert.equal((await start({ ...good, confirmation: "start" })).statusCode, 422);
    assert.equal((await start({ approvalToken: APPROVAL })).statusCode, 422);
    const started = await start(good);
    assert.equal(started.statusCode, 200);
    assert.equal((started.json() as { data: { ledgerState: string } }).data.ledgerState, "ready");
    assert.equal((await start(good)).statusCode, 409);
    const approved = await click(app, "standard", {
      expectedDigest: data.cards[0]!.actionDigest,
      decision: "approve",
    });
    assert.equal(approved.statusCode, 200);
  });

  it("shows execution and indeterminate status without running anything", async () => {
    const { app } = await open();
    const { standard } = await cards(app);
    const report = (status: string, headers: Record<string, string> = AUTH) =>
      app.inject({
        method: "POST",
        url: "/api/v1/owner-decisions/standard/executions",
        headers,
        payload: {
          expectedDigest: standard!.actionDigest,
          status,
          idempotencyKey: `http-test-exec-${(counter += 1)}`,
          reference: "Run 7",
        },
      });
    assert.equal((await report("executed", {})).statusCode, 401);
    assert.equal((await report("executed")).statusCode, 409);
    await click(app, "standard", { expectedDigest: standard!.actionDigest, decision: "approve" });
    const unknown = await report("indeterminate");
    assert.equal(unknown.statusCode, 200);
    const afterUnknown = (await cards(app)).standard as Card & { execution: { status: string } };
    assert.equal(afterUnknown.status, "APPROVED");
    assert.equal(afterUnknown.execution.status, "indeterminate");
    const withdraw = await click(app, "standard", {
      expectedDigest: standard!.actionDigest,
      decision: "reject",
    });
    assert.equal(withdraw.statusCode, 409);
    assert.match(withdraw.body, /owner-decision-execution-unresolved/);
    assert.equal((await report("executed")).statusCode, 200);
    assert.equal((await cards(app)).standard!.status, "EXECUTED");
    assert.equal((await report("failed")).statusCode, 409);
    assert.equal((await report("maybe")).statusCode, 422);
  });
});
