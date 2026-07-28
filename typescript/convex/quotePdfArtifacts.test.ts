import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "quote-pdf-artifact-test-token-000000000";

function harness() {
  return convexTest(schema, modules);
}

function createInput() {
  return {
    serviceToken: SERVICE_TOKEN,
    clientId: "client-1",
    projectId: "project-1",
    number: "BT-2026-ARTIFACT-001",
    lineItems: [{ description: "Electrical installation", quantity: 2, unitPrice: 125 }],
    taxRate: 0.1,
    validUntil: "2026-08-28",
    notes: "Approved scope only",
    termsIncluded: true,
  };
}

const issuer = {
  name: "Benny's Trade Services",
  abn: "12 345 678 901",
  email: "quotes@example.com",
  addressLines: ["Melbourne VIC"],
};

const client = {
  name: "Example Client Pty Ltd",
  email: "client@example.com",
  addressLines: ["10 Collins Street", "Melbourne VIC 3000"],
};

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("durable quote PDF finalisation", () => {
  it("locks the finalised revision and its exact PDF artefact together", async () => {
    const t = harness();
    const created = await t.mutation(api.quotes.create, createInput());
    const reviewed = await t.mutation(api.quotes.submitForReview, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
    });

    const result = await t.action(api.quoteFinalization.finalizeRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
      issuer,
      client,
    });

    expect(result.snapshot.revision.status).toBe("finalized");
    expect(result.snapshot.revision.fingerprint).toMatch(
      /^quote-revision:v1:sha256:[a-f0-9]{64}$/,
    );
    expect(result.artifact).toMatchObject({
      quoteId: created.aggregate.quoteId,
      revision: 1,
      revisionFingerprint: result.snapshot.revision.fingerprint,
      mediaType: "application/pdf",
      filename: "Quote-BT-2026-ARTIFACT-001-R1.pdf",
      rendererVersion: "quote-pdf:v1",
      issuer,
      client,
    });
    expect(result.artifact.digest).toMatch(/^quote-pdf:v1:sha256:[a-f0-9]{64}$/);
    expect(new Date(result.artifact.generatedAt).toISOString()).toBe(result.artifact.generatedAt);
    expect(result.artifact.byteLength).toBeGreaterThan(500);

    const stored = await t.run(async (ctx) => {
      const artifacts = await ctx.db.query("quotePdfArtifacts").collect();
      const artifact = artifacts[0];
      if (!artifact) return null;
      const metadata = await ctx.db.system.get("_storage", artifact.storageId);
      return { artifacts, metadata };
    });
    expect(stored?.artifacts).toHaveLength(1);
    expect(stored?.metadata).toMatchObject({
      contentType: "application/pdf",
      size: result.artifact.byteLength,
    });

    const retrieved = await t.query(api.quotePdfArtifacts.getForRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
    });
    expect(retrieved).toMatchObject({
      quoteId: created.aggregate.quoteId,
      revision: 1,
      digest: result.artifact.digest,
      byteLength: result.artifact.byteLength,
    });
    expect(retrieved?.url).toMatch(/^https?:\/\//);
  });
});
