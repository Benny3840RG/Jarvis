import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { ConvexQuoteRepository } from "../src/quotes/convexQuoteRepository.js";
import {
  QuoteFinalizedImmutableError,
  QuoteInvalidTransitionError,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteSnapshot,
} from "../src/quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../src/quotes/quoteDeliveryRepository.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "quote-http-lifecycle-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };
const ENVELOPE = { expectedAggregateVersion: 0, expectedRevisionVersion: 0 };
const FINALIZE_PAYLOAD = {
  ...ENVELOPE,
  issuer: { name: "Benny's Trade Services", email: "quotes@example.com" },
  client: { name: "Example Client", email: "client@example.com" },
  generatedAt: "2026-07-28T02:00:00.000Z",
};

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("legacy persistence must not be reached by the controlled quote lifecycle");
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
  aggregateOverrides: Partial<QuoteAggregate> = {},
  revisionOverrides: Partial<QuoteRevision> = {},
): QuoteSnapshot {
  return {
    aggregate: aggregate(aggregateOverrides),
    revision: revision(revisionOverrides),
  };
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
    async cleanup() {
      return true;
    },
    ...overrides,
  };
}

const openApps: NestFastifyApplication[] = [];

async function makeApp(
  quoteRepository: QuoteRepository | null,
  quoteDeliveryRepository: QuoteDeliveryRepository | null = null,
): Promise<NestFastifyApplication> {
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
    quoteDeliveryRepository,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  options: { payload?: object } = {},
) {
  return app.inject({
    method,
    url,
    headers: AUTH,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("controlled quote HTTP lifecycle", () => {
  it("exposes the approved /api/v1/quotes routes and verbs", async () => {
    const app = await makeApp(successfulRepository());

    const create = await inject(app, "POST", "/api/v1/quotes", {
      payload: {
        clientId: "client-1",
        number: "Q-1",
        lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
        termsIncluded: true,
      },
    });
    assert.equal(create.statusCode, 201);

    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/quotes/quote-1/revisions/1", {
          payload: { ...ENVELOPE, patch: { notes: "Call ahead" } },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes/quote-1/revisions/1/review", {
          payload: ENVELOPE,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes/quote-1/revisions/1/reopen", {
          payload: ENVELOPE,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes/quote-1/revisions/1/finalize", {
          payload: FINALIZE_PAYLOAD,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes/quote-1/revisions/1/fork", {
          payload: { ...ENVELOPE, expectedFingerprint: "fingerprint-1" },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/quotes/quote-1/commercial-outcome", {
          payload: { revision: 1, expectedAggregateVersion: 0, outcome: "accepted" },
        })
      ).statusCode,
      200,
    );
  });

  it("rejects client totals and generic status on create", async () => {
    const app = await makeApp(successfulRepository());
    const base = {
      clientId: "client-1",
      number: "Q-1",
      lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
      termsIncluded: true,
    };

    for (const forbidden of [{ status: "reviewed" }, { subtotal: 1 }, { tax: 1 }, { total: 1 }]) {
      const response = await inject(app, "POST", "/api/v1/quotes", {
        payload: { ...base, ...forbidden },
      });
      assert.equal(response.statusCode, 422);
    }
  });

  it("removes the legacy arbitrary update and delete routes", async () => {
    const app = await makeApp(successfulRepository());

    assert.equal(
      (
        await inject(app, "PATCH", "/api/v1/quotes/quote-1", {
          payload: { status: "accepted" },
        })
      ).statusCode,
      404,
    );
    assert.equal((await inject(app, "DELETE", "/api/v1/quotes/quote-1")).statusCode, 404);
  });

  it("maps serialized Convex version conflicts to 409", async () => {
    const serialized = new Error(
      "Server Error Uncaught QuoteVersionConflictError: expected versions do not match",
    );
    const client = {
      async query() {
        throw serialized;
      },
      async mutation() {
        throw serialized;
      },
    } as unknown as ConvexClientLike;
    const repository = new ConvexQuoteRepository({
      client,
      serviceToken: "quote-http-contract-token",
    });
    const app = await makeApp(repository);

    const response = await inject(app, "POST", "/api/v1/quotes/quote-1/revisions/1/review", {
      payload: ENVELOPE,
    });
    assert.equal(response.statusCode, 409);
  });

  it("maps direct draft finalisation and finalized patches to 409", async () => {
    const finalizeApp = await makeApp(
      successfulRepository({
        async finalizeRevision() {
          throw new QuoteInvalidTransitionError();
        },
      }),
    );
    assert.equal(
      (
        await inject(finalizeApp, "POST", "/api/v1/quotes/quote-1/revisions/1/finalize", {
          payload: FINALIZE_PAYLOAD,
        })
      ).statusCode,
      409,
    );

    const patchApp = await makeApp(
      successfulRepository({
        async updateDraft() {
          throw new QuoteFinalizedImmutableError();
        },
      }),
    );
    assert.equal(
      (
        await inject(patchApp, "PATCH", "/api/v1/quotes/quote-1/revisions/1", {
          payload: { ...ENVELOPE, patch: { notes: "No longer editable" } },
        })
      ).statusCode,
      409,
    );
  });

  it("returns the same 404 body for absent and cross-owner mutations", async () => {
    const calls: string[] = [];
    const app = await makeApp(
      successfulRepository({
        async updateDraft(input) {
          calls.push(input.quoteId);
          throw new Error("Quote not found.");
        },
      }),
    );

    const responses = await Promise.all(
      ["absent-quote", "cross-owner-quote"].map((quoteId) =>
        inject(app, "PATCH", `/api/v1/quotes/${quoteId}/revisions/1`, {
          payload: { ...ENVELOPE, patch: { notes: "x" } },
        }),
      ),
    );

    assert.deepEqual(calls, ["absent-quote", "cross-owner-quote"]);
    assert.equal(responses[0].statusCode, 404);
    assert.equal(responses[1].statusCode, 404);
    // `instance` (the request path) and `requestId` (a per-request
    // correlation id minted by ProblemDetailsFilter for every response, not
    // just this route) are expected to differ between the two requests; the
    // property under test is that absent vs. cross-owner give no other
    // distinguishing signal, so compare only the semantically meaningful
    // fields rather than the full body.
    const [absentBody, crossOwnerBody] = responses.map(
      (response) =>
        response.json() as { type: string; title: string; status: number; detail: string },
    );
    assert.deepEqual(
      {
        type: absentBody.type,
        title: absentBody.title,
        status: absentBody.status,
        detail: absentBody.detail,
      },
      {
        type: crossOwnerBody.type,
        title: crossOwnerBody.title,
        status: crossOwnerBody.status,
        detail: crossOwnerBody.detail,
      },
    );
  });

  it("stays unavailable when no delivery ledger is commissioned", async () => {
    const app = await makeApp(successfulRepository());
    const response = await inject(app, "GET", "/api/v1/quotes/quote-1/deliveries");

    assert.equal(response.statusCode, 503);
    assert.match(JSON.stringify(response.json()), /delivery/i);
  });

  it("lists a quote's delivery attempts without leaking internal correlation fields", async () => {
    const attempt: QuoteDeliveryAttempt = {
      deliveryAttemptId: "delivery-1",
      ownerId: "owner-1",
      quoteId: "quote-1",
      revision: 1,
      revisionId: "revision-1",
      revisionFingerprint: "quote-revision:v1:sha256:aaaa",
      recipient: "client@example.com",
      channel: "email",
      sendFingerprint: "quote-send-fingerprint:v1:sha256:bbbb",
      idempotencyKey: "execute-send-1",
      approvalId: "execute-send-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:cccc",
      status: "succeeded",
      provider: "test-email-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    };
    const deliveries: QuoteDeliveryRepository = {
      async getBySendScope() {
        return null;
      },
      async createPending() {
        throw new Error("not used in this test");
      },
      async markExecuting() {
        throw new Error("not used in this test");
      },
      async bindProviderReference() {
        throw new Error("not used in this test");
      },
      async complete() {
        throw new Error("not used in this test");
      },
      async markIndeterminate() {
        throw new Error("not used in this test");
      },
      async reconcile() {
        throw new Error("not used in this test");
      },
      async listForQuote() {
        return [attempt];
      },
      async cleanup() {
        return true;
      },
    };
    const app = await makeApp(successfulRepository(), deliveries);
    const response = await inject(app, "GET", "/api/v1/quotes/quote-1/deliveries");

    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: Record<string, unknown>[]; count: number };
    assert.equal(body.count, 1);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].deliveryAttemptId, "delivery-1");
    assert.equal(body.data[0].status, "succeeded");
    assert.equal("ownerId" in body.data[0], false);
    assert.equal("sendFingerprint" in body.data[0], false);
    assert.equal("idempotencyKey" in body.data[0], false);
    assert.equal("approvalId" in body.data[0], false);
    assert.equal("actionFingerprint" in body.data[0], false);
  });
});
