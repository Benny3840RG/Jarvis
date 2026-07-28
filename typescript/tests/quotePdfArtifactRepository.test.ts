import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConvexQuotePdfArtifactRepository,
  QuotePdfArtifactReadError,
} from "../src/quotes/quotePdfArtifactRepository.js";

const BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DIGEST =
  "quote-pdf:v1:sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b";
const FINGERPRINT = `quote-revision:v1:sha256:${"a".repeat(64)}`;

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "quote-1",
    revisionId: "revision-1",
    revision: 1,
    revisionFingerprint: FINGERPRINT,
    digest: DIGEST,
    byteLength: BYTES.byteLength,
    mediaType: "application/pdf",
    filename: "Quote-Q-1-R1.pdf",
    rendererVersion: "quote-pdf:v1",
    generatedAt: "2026-07-28T00:00:00.000Z",
    issuer: { name: "Benny" },
    client: { name: "Client" },
    createdAt: 1,
    url: "https://storage.example/locked-quote.pdf",
    ...overrides,
  };
}

describe("ConvexQuotePdfArtifactRepository", () => {
  it("returns only bytes matching the locked metadata, fingerprint, length and digest", async () => {
    const queries: Array<{ args: Record<string, unknown> }> = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const repository = new ConvexQuotePdfArtifactRepository({
      serviceToken: "owner-token",
      client: {
        async query(_reference: unknown, args: Record<string, unknown>) {
          queries.push({ args });
          return artifact();
        },
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(BYTES, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    const result = await repository.getForRevision(
      { quoteId: "quote-1", revision: 1, expectedRevisionFingerprint: FINGERPRINT },
      new AbortController().signal,
    );

    assert.ok(result);
    assert.deepEqual(result.bytes, BYTES);
    assert.equal(result.digest, DIGEST);
    assert.equal(result.filename, "Quote-Q-1-R1.pdf");
    assert.deepEqual(queries[0]?.args, {
      serviceToken: "owner-token",
      quoteId: "quote-1",
      revision: 1,
    });
    assert.equal(requests[0]?.url, "https://storage.example/locked-quote.pdf");
    assert.equal(requests[0]?.init.method, "GET");
    assert.equal(requests[0]?.init.redirect, "error");
    assert.equal(new Headers(requests[0]?.init.headers).get("accept"), "application/pdf");
  });

  it("returns null without downloading when the owner-scoped artifact is absent", async () => {
    let fetchCalls = 0;
    const repository = new ConvexQuotePdfArtifactRepository({
      serviceToken: "owner-token",
      client: { async query() { return null; } },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch-must-not-run");
      },
    });

    const result = await repository.getForRevision(
      { quoteId: "quote-1", revision: 1, expectedRevisionFingerprint: FINGERPRINT },
      new AbortController().signal,
    );

    assert.equal(result, null);
    assert.equal(fetchCalls, 0);
  });

  it("rejects fingerprint drift before downloading", async () => {
    let fetchCalls = 0;
    const repository = new ConvexQuotePdfArtifactRepository({
      serviceToken: "owner-token",
      client: { async query() { return artifact({ revisionFingerprint: "changed" }); } },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch-must-not-run");
      },
    });

    await assert.rejects(
      repository.getForRevision(
        { quoteId: "quote-1", revision: 1, expectedRevisionFingerprint: FINGERPRINT },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof QuotePdfArtifactReadError &&
        error.code === "quote-pdf-artifact-fingerprint-mismatch",
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects non-HTTPS storage URLs without downloading", async () => {
    let fetchCalls = 0;
    const repository = new ConvexQuotePdfArtifactRepository({
      serviceToken: "owner-token",
      client: { async query() { return artifact({ url: "http://storage.example/file.pdf" }); } },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch-must-not-run");
      },
    });

    await assert.rejects(
      repository.getForRevision(
        { quoteId: "quote-1", revision: 1, expectedRevisionFingerprint: FINGERPRINT },
        new AbortController().signal,
      ),
      /quote-pdf-artifact-url-invalid/u,
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects downloaded bytes that do not match the durable digest", async () => {
    const repository = new ConvexQuotePdfArtifactRepository({
      serviceToken: "owner-token",
      client: { async query() { return artifact(); } },
      fetch: async () =>
        new Response(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x00, 0x00, 0x00]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });

    await assert.rejects(
      repository.getForRevision(
        { quoteId: "quote-1", revision: 1, expectedRevisionFingerprint: FINGERPRINT },
        new AbortController().signal,
      ),
      /quote-pdf-artifact-digest-mismatch/u,
    );
  });
});
