import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import {
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteSnapshot,
} from "../src/quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";

type InjectMethod = "GET" | "POST";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "quote-revision-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in quote revision HTTP tests");
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

function aggregate(overrides: Partial<QuoteAggregate> = {}): QuoteAggregate {
  return {
    quoteId: "quote-1",
    ownerId: "owner-1",
    clientId: "client-1",
    number: "Q-1",
    currentRevision: 1,
    currentRevisionId: "revision-1",
    aggregateVersion: 0,
    commercialStatus: "open",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function revision(overrides: Partial<QuoteRevision> = {}): QuoteRevision {
  return {
    revisionId: "revision-1",
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    revisionVersion: 0,
    status: "draft",
    lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
    subtotal: 300,
    tax: 0,
    total: 300,
    currency: "AUD",
    termsIncluded: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<QuoteAggregate> = {},
  revisionOverrides: Partial<QuoteRevision> = {},
): QuoteSnapshot {
  return { aggregate: aggregate(overrides), revision: revision(revisionOverrides) };
}

function summary(overrides: Partial<QuoteSummary> = {}): QuoteSummary {
  return {
    quoteId: "quote-1",
    clientId: "client-1",
    number: "Q-1",
    currentRevision: 1,
    aggregateVersion: 0,
    revisionStatus: "draft",
    commercialStatus: "open",
    total: 300,
    currency: "AUD",
    updatedAt: 1,
    ...overrides,
  };
}

function successfulRepository(overrides: Partial<QuoteRepository> = {}): QuoteRepository {
  return {
    async createQuote() {
      return snapshot();
    },
    async getQuote(quoteId) {
      return quoteId === "quote-1" ? snapshot() : null;
    },
    async listQuotes() {
      return [summary()];
    },
    async updateDraft() {
      return snapshot();
    },
    async submitForReview() {
      return snapshot({}, { status: "reviewed" });
    },
    async reopenForEditing() {
      return snapshot();
    },
    async finalizeRevision() {
      return snapshot({}, { status: "finalized", fingerprint: "fingerprint-1" });
    },
    async createRevisionFromFinalized() {
      return snapshot({ currentRevision: 2 }, { revision: 2 });
    },
    async recordCommercialOutcome() {
      return snapshot({ commercialStatus: "accepted" });
    },
    ...overrides,
  };
}

const openApps: NestFastifyApplication[] = [];

async function makeApp(quoteRepository: QuoteRepository | null): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline: null,
    memoryChangeSetService: null,
    toolActionService: null,
    toolExecutionService: null,
    quoteRepository,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: InjectMethod,
  url: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return app.inject({
    method,
    url,
    headers: { ...(options.headers ?? {}) },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const ENVELOPE = { expectedAggregateVersion: 0, expectedRevisionVersion: 0 };

describe("quote revision HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp(successfulRepository());
    assert.equal((await inject(app, "GET", "/api/v1/quote-revisions")).statusCode, 401);
  });

  it("returns 503 on every route when Convex is not configured", async () => {
    const app = await makeApp(null);
    assert.equal(
      (await inject(app, "GET", "/api/v1/quote-revisions", { headers: AUTH })).statusCode,
      503,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quote-revisions", {
          headers: AUTH,
          payload: {
            clientId: "client-1",
            number: "Q-1",
            lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
            termsIncluded: true,
          },
        })
      ).statusCode,
      503,
    );
  });

  it("creates a quote and returns the snapshot", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "POST", "/api/v1/quote-revisions", {
      headers: AUTH,
      payload: {
        clientId: "client-1",
        number: "Q-1",
        lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
        termsIncluded: true,
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.data.aggregate.quoteId, "quote-1");
    assert.equal(body.data.revision.status, "draft");
  });

  it("rejects an invalid create request before calling the repository", async () => {
    const app = await makeApp(
      successfulRepository({
        async createQuote() {
          throw new Error("repository must not be called for an invalid request");
        },
      }),
    );
    const response = await inject(app, "POST", "/api/v1/quote-revisions", {
      headers: AUTH,
      payload: { clientId: "client-1", number: "Q-1", lineItems: [], termsIncluded: true },
    });
    assert.equal(response.statusCode, 422);
  });

  it("lists quote summaries", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "GET", "/api/v1/quote-revisions", { headers: AUTH });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.count, 1);
    assert.equal(body.data[0].quoteId, "quote-1");
  });

  it("gets one quote by id", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "GET", "/api/v1/quote-revisions/quote-1", { headers: AUTH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.aggregate.quoteId, "quote-1");
  });

  it("returns 404 when the quote does not exist", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "GET", "/api/v1/quote-revisions/missing", { headers: AUTH });
    assert.equal(response.statusCode, 404);
  });

  it("patches a draft revision", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/draft",
      {
        headers: AUTH,
        payload: { ...ENVELOPE, patch: { notes: "Call ahead" } },
      },
    );
    assert.equal(response.statusCode, 200);
  });

  it("submits a revision for review", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/submit",
      {
        headers: AUTH,
        payload: ENVELOPE,
      },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.revision.status, "reviewed");
  });

  it("reopens a revision for editing", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/reopen",
      {
        headers: AUTH,
        payload: ENVELOPE,
      },
    );
    assert.equal(response.statusCode, 200);
  });

  it("finalizes a revision", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/finalize",
      {
        headers: AUTH,
        payload: ENVELOPE,
      },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.revision.status, "finalized");
  });

  it("forks a new revision from a finalized revision", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "POST", "/api/v1/quote-revisions/quote-1/revisions/1/fork", {
      headers: AUTH,
      payload: { ...ENVELOPE, expectedFingerprint: "fingerprint-1" },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.revision.revision, 2);
  });

  it("records a commercial outcome", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/commercial-outcome",
      {
        headers: AUTH,
        payload: { revision: 1, expectedAggregateVersion: 0, outcome: "accepted" },
      },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.aggregate.commercialStatus, "accepted");
  });

  it("maps a version conflict to 409 without leaking backend details", async () => {
    const app = await makeApp(
      successfulRepository({
        async submitForReview() {
          throw new QuoteVersionConflictError();
        },
      }),
    );
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/submit",
      {
        headers: AUTH,
        payload: ENVELOPE,
      },
    );
    assert.equal(response.statusCode, 409);
  });

  it("maps an invalid transition to 409", async () => {
    const app = await makeApp(
      successfulRepository({
        async submitForReview() {
          throw new QuoteInvalidTransitionError();
        },
      }),
    );
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/submit",
      {
        headers: AUTH,
        payload: ENVELOPE,
      },
    );
    assert.equal(response.statusCode, 409);
  });

  it("maps a finalized-immutable error to 409", async () => {
    const app = await makeApp(
      successfulRepository({
        async updateDraft() {
          throw new QuoteFinalizedImmutableError();
        },
      }),
    );
    const response = await inject(
      app,
      "POST",
      "/api/v1/quote-revisions/quote-1/revisions/1/draft",
      {
        headers: AUTH,
        payload: { ...ENVELOPE, patch: { notes: "x" } },
      },
    );
    assert.equal(response.statusCode, 409);
  });

  it("maps a fingerprint mismatch to 409", async () => {
    const app = await makeApp(
      successfulRepository({
        async createRevisionFromFinalized() {
          throw new QuoteFingerprintMismatchError();
        },
      }),
    );
    const response = await inject(app, "POST", "/api/v1/quote-revisions/quote-1/revisions/1/fork", {
      headers: AUTH,
      payload: { ...ENVELOPE, expectedFingerprint: "wrong" },
    });
    assert.equal(response.statusCode, 409);
  });
});
