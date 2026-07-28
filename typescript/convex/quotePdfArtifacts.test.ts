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
    expect(new Date(result.artifact.generatedAt).toISOString()).toBe(
      result.artifact.generatedAt,
    );
    expect(result.artifact.byteLength).toBeGreaterThan(500);

    const stored = await t.run(async (ctx) => {
      const artifacts = await ctx.db.query("quotePdfArtifacts").collect();
      const artifact = artifacts[0];
      if (!artifact) return null;
      const metadata = await ctx.db.system.get("_storage", artifact.storageId);
      return { artifacts, metadata, storageId: artifact.storageId };
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

    expect(
      await t.mutation(api.quotes.cleanup, {
        serviceToken: SERVICE_TOKEN,
        quoteId: created.aggregate.quoteId,
        deployment: "dev:outgoing-ram-798",
      }),
    ).toBe(true);
    const afterCleanup = await t.run(async (ctx) => ({
      artifacts: (await ctx.db.query("quotePdfArtifacts").collect()).length,
      metadata: await ctx.db.system.get("_storage", stored!.storageId),
    }));
    expect(afterCleanup).toEqual({ artifacts: 0, metadata: null });
  });

  it("keeps the reviewed revision unchanged when the legacy mutation is called", async () => {
    const t = harness();
    const created = await t.mutation(api.quotes.create, createInput());
    const reviewed = await t.mutation(api.quotes.submitForReview, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
    });

    await expect(
      t.mutation(api.quotes.finalizeRevision, {
        serviceToken: SERVICE_TOKEN,
        quoteId: created.aggregate.quoteId,
        revision: 1,
        expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
        expectedRevisionVersion: reviewed.revision.revisionVersion,
      }),
    ).rejects.toThrow(/durable PDF artifact/);

    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
    });
    expect(persisted?.revision.status).toBe("reviewed");
    expect(
      await t.run(async (ctx) => (await ctx.db.query("quotePdfArtifacts").collect()).length),
    ).toBe(0);
  });

  it("does not replace the locked artefact on a duplicate finalisation", async () => {
    const t = harness();
    const created = await t.mutation(api.quotes.create, createInput());
    const reviewed = await t.mutation(api.quotes.submitForReview, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
    });
    const args = {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
      issuer,
      client,
    };

    const first = await t.action(api.quoteFinalization.finalizeRevision, args);
    await expect(t.action(api.quoteFinalization.finalizeRevision, args)).rejects.toThrow(
      /reviewed|version/i,
    );

    const artifacts = await t.run(async (ctx) =>
      ctx.db.query("quotePdfArtifacts").collect(),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.digest).toBe(first.artifact.digest);
  });

  it("returns null for both absent and cross-owner artefacts", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array([37, 80, 68, 70]).buffer as ArrayBuffer], {
          type: "application/pdf",
        }),
      );
      await ctx.db.insert("quotePdfArtifacts", {
        ownerId: "other-owner",
        quoteId: "other-quote",
        revisionId: "other-revision",
        revision: 1,
        revisionFingerprint: `quote-revision:v1:sha256:${"a".repeat(64)}`,
        storageId,
        digest: `quote-pdf:v1:sha256:${"b".repeat(64)}`,
        byteLength: 4,
        mediaType: "application/pdf",
        filename: "other.pdf",
        rendererVersion: "quote-pdf:v1",
        generatedAt: "2026-07-28T02:00:00.000Z",
        issuer,
        client,
        createdAt: 1,
      });
    });

    const absent = await t.query(api.quotePdfArtifacts.getForRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "missing-quote",
      revision: 1,
    });
    const crossOwner = await t.query(api.quotePdfArtifacts.getForRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "other-quote",
      revision: 1,
    });
    expect(absent).toBeNull();
    expect(crossOwner).toBeNull();
  });
});
