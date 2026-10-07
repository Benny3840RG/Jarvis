import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import {
  LifecycleQuoteRegisterError,
  briefQuoteStatus,
  quoteFromLifecycleSnapshot,
  readLifecycleQuoteRegister,
  succeededDeliveryReceiptForRevision,
} from "../src/briefs/lifecycleBriefQuotes.js";
import type { DailyBrief } from "../src/briefs/brief.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../src/quotes/quoteDeliveryRepository.js";
import type { QuoteAggregate, QuoteRevision, QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "lifecycle-brief-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function aggregate(overrides: Partial<QuoteAggregate> = {}): QuoteAggregate {
  return {
    quoteId: "lifecycle-1",
    ownerId: "owner-1",
    clientId: "client-1",
    projectId: "job-1",
    number: "Q-LIFE",
    currentRevision: 1,
    currentRevisionId: "revision-1",
    aggregateVersion: 2,
    commercialStatus: "open",
    createdAt: 10,
    updatedAt: 40,
    ...overrides,
  };
}

function revision(overrides: Partial<QuoteRevision> = {}): QuoteRevision {
  return {
    revisionId: "revision-1",
    ownerId: "owner-1",
    quoteId: "lifecycle-1",
    revision: 1,
    revisionVersion: 2,
    status: "finalized",
    lineItems: [{ description: "Deck boards", quantity: 3, unitPrice: 190 }],
    subtotal: 570,
    taxRate: 0.1,
    tax: 57,
    total: 627,
    currency: "AUD",
    validUntil: "2026-11-01",
    notes: "Call ahead",
    termsIncluded: true,
    fingerprint: "quote-revision:v1:sha256:abc",
    createdAt: 10,
    updatedAt: 30,
    ...overrides,
  };
}

function snapshot(
  aggregateOverrides: Partial<QuoteAggregate> = {},
  revisionOverrides: Partial<QuoteRevision> = {},
): QuoteSnapshot {
  const aggregateRow = aggregate(aggregateOverrides);
  return {
    aggregate: aggregateRow,
    revision: revision({ quoteId: aggregateRow.quoteId, ...revisionOverrides }),
  };
}

function summaryFor(row: QuoteSnapshot, overrides: Partial<QuoteSummary> = {}): QuoteSummary {
  return {
    quoteId: row.aggregate.quoteId,
    clientId: row.aggregate.clientId,
    ...(row.aggregate.projectId === undefined ? {} : { projectId: row.aggregate.projectId }),
    number: row.aggregate.number,
    currentRevision: row.aggregate.currentRevision,
    aggregateVersion: row.aggregate.aggregateVersion,
    revisionStatus: row.revision.status,
    commercialStatus: row.aggregate.commercialStatus,
    total: row.revision.total,
    currency: "AUD",
    updatedAt: row.aggregate.updatedAt,
    ...overrides,
  };
}

function repositoryFor(
  rows: QuoteSnapshot[],
  overrides: Partial<QuoteRepository> = {},
): QuoteRepository {
  const unused = (): Promise<never> => Promise.reject(new Error("unused quote repository method"));
  return {
    createQuote: unused,
    async getQuote(quoteId) {
      return rows.find((row) => row.aggregate.quoteId === quoteId) ?? null;
    },
    async listQuotes() {
      return rows.map((row) => summaryFor(row));
    },
    updateDraft: unused,
    submitForReview: unused,
    reopenForEditing: unused,
    finalizeRevision: unused,
    createRevisionFromFinalized: unused,
    recordCommercialOutcome: unused,
    cleanup: unused,
    ...overrides,
  };
}

function deliveryAttempt(overrides: Partial<QuoteDeliveryAttempt> = {}): QuoteDeliveryAttempt {
  return {
    deliveryAttemptId: "delivery-1",
    ownerId: "owner-1",
    quoteId: "lifecycle-1",
    revision: 1,
    revisionId: "revision-1",
    revisionFingerprint: "quote-revision:v1:sha256:abc",
    recipient: "client@example.com",
    channel: "email",
    sendFingerprint: "quote-send-fingerprint:v1:sha256:bbbb",
    idempotencyKey: "execute-send-1",
    approvalId: "execute-send-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:cccc",
    status: "succeeded",
    provider: "test-email-provider",
    createdAt: 50,
    updatedAt: 50,
    completedAt: 50,
    ...overrides,
  };
}

function deliveryRepository(
  attempts: QuoteDeliveryAttempt[],
  overrides: Partial<QuoteDeliveryRepository> = {},
): QuoteDeliveryRepository {
  const unused = (): Promise<never> => Promise.reject(new Error("unused quote delivery method"));
  return {
    getBySendScope: unused,
    createPending: unused,
    markExecuting: unused,
    bindProviderReference: unused,
    complete: unused,
    markIndeterminate: unused,
    reconcile: unused,
    async listForQuote(input) {
      return attempts.filter((attempt) => attempt.quoteId === input.quoteId);
    },
    cleanup: unused,
    ...overrides,
  };
}

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("mutations must not be reached");
  };
  return {
    loadState: () => Promise.resolve({}),
    saveState: forbidden,
    listTasks: () => Promise.resolve([]),
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: () => Promise.resolve([]),
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

function credentials(): CredentialsRuntime {
  return captureCredentials({
    serviceToken: "current-secret",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: false,
    tlsTerminated: false,
    oidcConfigured: false,
    originsConfigured: false,
    persistenceProvider: "json",
  });
}

const openApps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("lifecycle quotes in the daily brief", () => {
  it("keeps an open finalized revision as draft until that revision was delivered", () => {
    const row = snapshot();
    const quote = quoteFromLifecycleSnapshot(row, { hasSucceededDelivery: false });
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "finalized",
        commercialStatus: "open",
        hasSucceededDelivery: false,
      }),
      "draft",
    );
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "finalized",
        commercialStatus: "open",
        hasSucceededDelivery: true,
      }),
      "sent",
    );
    assert.equal(quote.status, "draft");
    assert.equal(quote.id, "lifecycle-1");
    assert.equal(quote.total, 627);
    assert.equal(quote.subtotal, 570);
    assert.equal(quote.tax, 57);
    assert.deepEqual(quote.lineItems, [
      { description: "Deck boards", quantity: 3, unitPrice: 190 },
    ]);
    assert.equal(quote.notes, "Call ahead");
    assert.equal(quote.updatedAt, 40);
  });

  it("keeps reviewed work as draft and closed commercial outcomes out of the pipeline", () => {
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "reviewed",
        commercialStatus: "open",
        hasSucceededDelivery: false,
      }),
      "draft",
    );
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "draft",
        commercialStatus: "open",
        hasSucceededDelivery: true,
      }),
      "draft",
    );
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "finalized",
        commercialStatus: "accepted",
        hasSucceededDelivery: true,
      }),
      "accepted",
    );
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "finalized",
        commercialStatus: "declined",
        hasSucceededDelivery: false,
      }),
      "declined",
    );
    assert.equal(
      briefQuoteStatus({
        revisionStatus: "finalized",
        commercialStatus: "expired",
        hasSucceededDelivery: false,
      }),
      "declined",
    );
  });

  it("accepts only a succeeded receipt for the current revision", () => {
    const row = snapshot().revision;
    assert.equal(succeededDeliveryReceiptForRevision(deliveryAttempt(), row), true);
    assert.equal(
      succeededDeliveryReceiptForRevision(
        deliveryAttempt({ status: "reconciled", reconciledOutcome: "succeeded" }),
        row,
      ),
      true,
    );
    for (const status of ["pending", "executing", "failed", "indeterminate"] as const) {
      assert.equal(succeededDeliveryReceiptForRevision(deliveryAttempt({ status }), row), false);
    }
    assert.equal(
      succeededDeliveryReceiptForRevision(
        deliveryAttempt({ status: "reconciled", reconciledOutcome: "failed" }),
        row,
      ),
      false,
    );
    assert.equal(
      succeededDeliveryReceiptForRevision(
        deliveryAttempt({ revision: 2, revisionId: "revision-2" }),
        row,
      ),
      false,
    );
    assert.equal(
      succeededDeliveryReceiptForRevision(deliveryAttempt({ revisionId: "revision-other" }), row),
      false,
    );
    assert.equal(
      succeededDeliveryReceiptForRevision(
        deliveryAttempt({ revisionFingerprint: "quote-revision:v1:sha256:other" }),
        row,
      ),
      false,
    );
  });

  it("does not invent a delivery when the ledger is absent", async () => {
    const register = await readLifecycleQuoteRegister(repositoryFor([snapshot()]), null);
    assert.equal(register.summaries[0]?.revisionStatus, "finalized");
    assert.equal(register.quotes[0]?.status, "draft");
  });

  it("projects a succeeded receipt for the current revision as sent", async () => {
    const register = await readLifecycleQuoteRegister(
      repositoryFor([snapshot()]),
      deliveryRepository([deliveryAttempt()]),
    );
    assert.equal(register.quotes[0]?.status, "sent");
    const reconciled = await readLifecycleQuoteRegister(
      repositoryFor([snapshot()]),
      deliveryRepository([
        deliveryAttempt({ status: "reconciled", reconciledOutcome: "succeeded" }),
      ]),
    );
    assert.equal(reconciled.quotes[0]?.status, "sent");
  });

  it("fails closed when a listed quote has no matching snapshot", async () => {
    const row = snapshot();
    await assert.rejects(
      () =>
        readLifecycleQuoteRegister(
          repositoryFor([row], {
            async getQuote() {
              return null;
            },
          }),
          deliveryRepository([deliveryAttempt()]),
        ),
      LifecycleQuoteRegisterError,
    );
  });

  it("does not count a finalized quote as sent when no delivery succeeded", async () => {
    const flat = new InMemoryQuoteStore();
    await flat.add({
      clientId: "client-flat",
      number: "Q-FLAT",
      status: "sent",
      lineItems: [{ description: "Old file", quantity: 1, unitPrice: 10 }],
    });
    const app = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: CONFIG,
      logger: false,
      quoteStore: flat,
      quoteRepository: repositoryFor([snapshot()]),
      quoteDeliveryRepository: deliveryRepository([
        deliveryAttempt({ status: "failed", providerErrorCode: "rejected" }),
        deliveryAttempt({
          deliveryAttemptId: "delivery-old",
          revision: 2,
          revisionId: "revision-2",
          status: "succeeded",
        }),
      ]),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 200);
    const brief = response.json<{ data: DailyBrief }>().data;
    assert.equal(brief.quotes.countsByStatus.sent, 0);
    assert.equal(brief.quotes.countsByStatus.draft, 1);
    assert.equal(brief.quotes.pipelineTotal, 0);
    assert.equal(brief.quotes.awaitingResponse.length, 0);
    assert.equal(brief.quotes.drafts[0]?.id, "lifecycle-1");
    assert.equal(brief.quotes.drafts[0]?.number, "Q-LIFE");
    assert.equal(brief.quotes.drafts[0]?.status, "draft");
    assert.equal(brief.quotes.drafts[0]?.total, 627);
    assert.equal(brief.headline.includes("1 quote awaiting response"), false);
    assert.equal(brief.headline.includes("0 quotes awaiting response"), true);
    assert.equal(JSON.stringify(brief).includes("Q-FLAT"), false);
  });

  it("counts a finalized revision as sent when that revision has a succeeded delivery receipt", async () => {
    const flat = new InMemoryQuoteStore();
    await flat.add({
      clientId: "client-flat",
      number: "Q-FLAT",
      status: "draft",
      lineItems: [{ description: "Old file", quantity: 1, unitPrice: 10 }],
    });
    const app = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: CONFIG,
      credentialsRuntime: credentials(),
      logger: false,
      quoteStore: flat,
      quoteRepository: repositoryFor([snapshot()]),
      quoteDeliveryRepository: deliveryRepository([deliveryAttempt()]),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 200);
    const brief = response.json<{ data: DailyBrief }>().data;
    assert.equal(brief.quotes.countsByStatus.sent, 1);
    assert.equal(brief.quotes.countsByStatus.draft, 0);
    assert.equal(brief.quotes.pipelineTotal, 627);
    assert.equal(brief.quotes.awaitingResponse.length, 1);
    assert.equal(brief.quotes.awaitingResponse[0]?.id, "lifecycle-1");
    assert.equal(brief.quotes.awaitingResponse[0]?.number, "Q-LIFE");
    assert.equal(brief.quotes.awaitingResponse[0]?.status, "sent");
    assert.equal(brief.quotes.awaitingResponse[0]?.total, 627);
    assert.equal(brief.quotes.awaitingResponse[0]?.lineItems[0]?.description, "Deck boards");
    assert.equal(brief.headline.includes("1 quote awaiting response"), true);
    assert.equal(JSON.stringify(brief).includes("Q-FLAT"), false);

    const hud = await app.inject({ method: "GET", url: "/api/v1/hud/snapshot" });
    assert.equal(hud.statusCode, 200);
    const body = hud.json<{
      brief: DailyBrief;
      quoteRegister: { status: string; quotes: QuoteSummary[] };
    }>();
    assert.equal(body.quoteRegister.quotes[0]?.revisionStatus, "finalized");
    assert.equal(body.brief.quotes.awaitingResponse[0]?.id, "lifecycle-1");
    assert.equal(body.brief.quotes.countsByStatus.sent, 1);
  });

  it("returns 503 when the lifecycle register cannot be read", async () => {
    const flat = new InMemoryQuoteStore();
    await flat.add({
      clientId: "client-flat",
      number: "Q-FLAT",
      status: "sent",
      lineItems: [{ description: "Old file", quantity: 1, unitPrice: 10 }],
    });
    const app = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: CONFIG,
      logger: false,
      quoteStore: flat,
      quoteRepository: repositoryFor([], {
        async listQuotes() {
          throw new Error("register offline");
        },
      }),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json<{ type: string }>().type, "urn:jarvis:problem:brief-unavailable");
    assert.equal(response.body.includes("Q-FLAT"), false);
  });

  it("puts the same finalized quote in the HUD brief and the HUD register", async () => {
    const app = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: CONFIG,
      credentialsRuntime: credentials(),
      logger: false,
      quoteRepository: repositoryFor([snapshot()]),
      quoteDeliveryRepository: deliveryRepository([]),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/hud/snapshot" });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      brief: DailyBrief;
      quoteRegister: { status: string; quotes: QuoteSummary[] };
    }>();
    assert.equal(body.quoteRegister.status, "ready");
    assert.equal(body.quoteRegister.quotes[0]?.quoteId, "lifecycle-1");
    assert.equal(body.quoteRegister.quotes[0]?.revisionStatus, "finalized");
    assert.equal(body.brief.quotes.countsByStatus.sent, 0);
    assert.equal(body.brief.quotes.awaitingResponse.length, 0);
    assert.equal(body.brief.quotes.pipelineTotal, 0);
    assert.equal(body.brief.quotes.drafts[0]?.id, body.quoteRegister.quotes[0]?.quoteId);
    assert.equal(body.brief.headline.includes("1 quote awaiting response"), false);
  });

  it("returns 503 when the delivery ledger cannot be read for a finalized quote", async () => {
    const flat = new InMemoryQuoteStore();
    await flat.add({
      clientId: "client-flat",
      number: "Q-FLAT",
      status: "sent",
      lineItems: [{ description: "Old file", quantity: 1, unitPrice: 10 }],
    });
    const app = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: CONFIG,
      logger: false,
      quoteStore: flat,
      quoteRepository: repositoryFor([snapshot()]),
      quoteDeliveryRepository: deliveryRepository([], {
        async listForQuote() {
          throw new Error("delivery ledger offline");
        },
      }),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json<{ type: string }>().type, "urn:jarvis:problem:brief-unavailable");
    assert.equal(response.body.includes("Q-FLAT"), false);
    assert.equal(response.body.includes("Q-LIFE"), false);
  });
});
