import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type { QuoteAggregate, QuoteRevision, QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import {
  QuotePdfArtifactReadError,
  type QuotePdfArtifactContent,
  type QuotePdfArtifactReadInput,
  type QuotePdfArtifactRepository,
} from "../src/quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository } from "../src/quotes/quoteRepository.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "quote-pdf-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };
const DIGEST = `quote-pdf:v1:sha256:${"ab".repeat(32)}`;
const PDF = Buffer.from("%PDF-1.4\nstored\n");

function aggregate(overrides: Partial<QuoteAggregate> = {}): QuoteAggregate {
  return {
    quoteId: "quote-1",
    ownerId: "owner-1",
    clientId: "client-1",
    number: "Q-1",
    currentRevision: 1,
    currentRevisionId: "revision-1",
    aggregateVersion: 1,
    commercialStatus: "open",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function revision(overrides: Partial<QuoteRevision> = {}): QuoteRevision {
  return {
    revisionId: "revision-1",
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    revisionVersion: 1,
    status: "finalized",
    lineItems: [{ description: "Panel", quantity: 1, unitPrice: 10 }],
    subtotal: 10,
    tax: 0,
    total: 10,
    currency: "AUD",
    termsIncluded: true,
    fingerprint: "quote-revision:v1:sha256:fingerprint",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function snapshot(
  aggregateOverrides: Partial<QuoteAggregate> = {},
  revisionOverrides: Partial<QuoteRevision> = {},
): QuoteSnapshot {
  return { aggregate: aggregate(aggregateOverrides), revision: revision(revisionOverrides) };
}

function quotes(row: QuoteSnapshot | null = snapshot()): QuoteRepository {
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  return {
    createQuote: unused,
    async getQuote(quoteId) {
      return row && quoteId === row.aggregate.quoteId ? row : null;
    },
    async listQuotes() {
      return [];
    },
    updateDraft: unused,
    submitForReview: unused,
    reopenForEditing: unused,
    finalizeRevision: unused,
    createRevisionFromFinalized: unused,
    recordCommercialOutcome: unused,
    cleanup: unused,
  };
}

function artifact(overrides: Partial<QuotePdfArtifactContent> = {}): QuotePdfArtifactContent {
  return {
    quoteId: "quote-1",
    revisionId: "revision-1",
    revision: 1,
    revisionFingerprint: "quote-revision:v1:sha256:fingerprint",
    filename: "Quote-Q-1-R1.pdf",
    mediaType: "application/pdf",
    digest: DIGEST,
    byteLength: PDF.byteLength,
    bytes: PDF,
    ...overrides,
  };
}

function pdfRepository(
  behavior: (
    input: QuotePdfArtifactReadInput,
  ) => Promise<QuotePdfArtifactContent | null> = async () => artifact(),
): QuotePdfArtifactRepository & { calls: QuotePdfArtifactReadInput[] } {
  const calls: QuotePdfArtifactReadInput[] = [];
  return {
    calls,
    async getForRevision(input) {
      calls.push(input);
      return behavior(input);
    },
  };
}

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("unused persistence");
  };
  return {
    loadState: forbidden,
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

const openApps: NestFastifyApplication[] = [];

async function makeApp(options: {
  quoteRepository?: QuoteRepository | null;
  quotePdfArtifactRepository?: QuotePdfArtifactRepository | null;
}): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: persistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    quoteRepository: options.quoteRepository === undefined ? quotes() : options.quoteRepository,
    quotePdfArtifactRepository:
      options.quotePdfArtifactRepository === undefined
        ? pdfRepository()
        : options.quotePdfArtifactRepository,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("operator quote PDF read", () => {
  it("serves the stored artifact after the reader verifies the current fingerprint", async () => {
    const stored = pdfRepository();
    const app = await makeApp({ quotePdfArtifactRepository: stored });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^application\/pdf/);
    assert.equal(response.headers["x-quote-pdf-digest"], DIGEST);
    assert.match(String(response.headers["content-disposition"]), /Quote-Q-1-R1\.pdf/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.rawPayload, PDF);
    assert.deepEqual(stored.calls, [
      {
        quoteId: "quote-1",
        revision: 1,
        expectedRevisionFingerprint: "quote-revision:v1:sha256:fingerprint",
      },
    ]);
  });

  it("requires authentication", async () => {
    const app = await makeApp({});
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
    });
    assert.equal(response.statusCode, 401);
  });

  it("returns 409 and no PDF bytes when digest verification fails", async () => {
    const app = await makeApp({
      quotePdfArtifactRepository: pdfRepository(async () => {
        throw new QuotePdfArtifactReadError("quote-pdf-artifact-digest-mismatch");
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ type: string }>().type,
      "urn:jarvis:problem:quote-pdf-artifact-digest-mismatch",
    );
    assert.equal(response.headers["content-type"]?.includes("application/pdf"), false);
    assert.equal(response.rawPayload.includes(Buffer.from("%PDF")), false);
  });

  it("returns 409 when the stored fingerprint does not match the revision", async () => {
    const app = await makeApp({
      quotePdfArtifactRepository: pdfRepository(async () => {
        throw new QuotePdfArtifactReadError("quote-pdf-artifact-fingerprint-mismatch");
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ type: string }>().type,
      "urn:jarvis:problem:quote-pdf-artifact-fingerprint-mismatch",
    );
  });

  it("returns 404 when no artifact is stored", async () => {
    const app = await makeApp({
      quotePdfArtifactRepository: pdfRepository(async () => null),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 404);
  });

  it("returns 404 for a non-current or non-finalized revision", async () => {
    const draftApp = await makeApp({
      quoteRepository: quotes(snapshot({}, { status: "reviewed", fingerprint: undefined })),
    });
    const draft = await draftApp.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(draft.statusCode, 404);

    const staleApp = await makeApp({
      quoteRepository: quotes(snapshot({ currentRevision: 2 })),
    });
    const stale = await staleApp.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(stale.statusCode, 404);
  });

  it("returns 503 when the artifact reader is not configured", async () => {
    const app = await makeApp({ quotePdfArtifactRepository: null });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      response.json<{ type: string }>().type,
      "urn:jarvis:problem:quote-pdf-unavailable",
    );
  });

  it("returns 503 without a storage URL when the reader cannot download the artifact", async () => {
    const app = await makeApp({
      quotePdfArtifactRepository: pdfRepository(async () => {
        throw new QuotePdfArtifactReadError("quote-pdf-artifact-download-failed");
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quotes/quote-1/revisions/1/pdf",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      response.json<{ type: string }>().type,
      "urn:jarvis:problem:quote-pdf-artifact-download-failed",
    );
    assert.equal(response.body.includes("http"), false);
  });
});
