import { createHash } from "node:crypto";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "../persistence/convexPersistence.js";
import type { QuoteEmailAttachment } from "./quoteEmailProvider.js";

const MAX_PDF_BYTES = 2 * 1024 * 1024;
const PDF_MEDIA_TYPE = "application/pdf";
const PDF_DIGEST_PATTERN = /^quote-pdf:v1:sha256:([a-f0-9]{64})$/u;

export type QuotePdfArtifactReadInput = {
  quoteId: string;
  revision: number;
  expectedRevisionFingerprint: string;
};

export type QuotePdfArtifactContent = QuoteEmailAttachment & {
  quoteId: string;
  revisionId: string;
  revision: number;
  revisionFingerprint: string;
  byteLength: number;
};

export interface QuotePdfArtifactRepository {
  getForRevision(
    input: QuotePdfArtifactReadInput,
    signal: AbortSignal,
  ): Promise<QuotePdfArtifactContent | null>;
}

type ArtifactMetadata = {
  quoteId: string;
  revisionId: string;
  revision: number;
  revisionFingerprint: string;
  digest: string;
  byteLength: number;
  mediaType: string;
  filename: string;
  url: string;
};

export type ConvexQuotePdfArtifactRepositoryOptions = {
  client: Pick<ConvexClientLike, "query">;
  serviceToken: string;
  fetch?: typeof globalThis.fetch;
};

export class QuotePdfArtifactReadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuotePdfArtifactReadError";
  }
}

function fail(code: string): never {
  throw new QuotePdfArtifactReadError(code);
}

function validateMetadata(value: unknown, input: QuotePdfArtifactReadInput): ArtifactMetadata {
  if (typeof value !== "object" || value === null) fail("quote-pdf-artifact-response-invalid");
  const record = value as Record<string, unknown>;
  if (
    record.quoteId !== input.quoteId ||
    typeof record.revisionId !== "string" ||
    !record.revisionId ||
    record.revision !== input.revision ||
    typeof record.revisionFingerprint !== "string" ||
    typeof record.digest !== "string" ||
    typeof record.byteLength !== "number" ||
    !Number.isInteger(record.byteLength) ||
    record.byteLength < 5 ||
    record.byteLength > MAX_PDF_BYTES ||
    record.mediaType !== PDF_MEDIA_TYPE ||
    typeof record.filename !== "string" ||
    !record.filename ||
    record.filename.length > 160 ||
    !record.filename.toLowerCase().endsWith(".pdf") ||
    /[\\/]/u.test(record.filename) ||
    typeof record.url !== "string"
  ) {
    fail("quote-pdf-artifact-response-invalid");
  }
  if (record.revisionFingerprint !== input.expectedRevisionFingerprint) {
    fail("quote-pdf-artifact-fingerprint-mismatch");
  }
  if (!PDF_DIGEST_PATTERN.test(record.digest)) fail("quote-pdf-artifact-digest-invalid");
  return record as unknown as ArtifactMetadata;
}

function storageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("quote-pdf-artifact-url-invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hash) {
    fail("quote-pdf-artifact-url-invalid");
  }
  return url;
}

async function readExactBody(response: Response, expectedByteLength: number): Promise<Uint8Array> {
  if (!response.body) fail("quote-pdf-artifact-body-missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expectedByteLength) {
        await reader.cancel();
        fail("quote-pdf-artifact-length-mismatch");
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    if (error instanceof QuotePdfArtifactReadError) throw error;
    fail("quote-pdf-artifact-download-failed");
  }
  if (total !== expectedByteLength) fail("quote-pdf-artifact-length-mismatch");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class ConvexQuotePdfArtifactRepository implements QuotePdfArtifactRepository {
  private readonly client: Pick<ConvexClientLike, "query">;
  private readonly serviceToken: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: ConvexQuotePdfArtifactRepositoryOptions) {
    this.client = options.client;
    this.serviceToken = options.serviceToken.trim();
    this.fetch = options.fetch ?? globalThis.fetch;
    if (!this.serviceToken) fail("quote-pdf-artifact-service-token-missing");
  }

  async getForRevision(
    input: QuotePdfArtifactReadInput,
    signal: AbortSignal,
  ): Promise<QuotePdfArtifactContent | null> {
    let raw: unknown;
    try {
      raw = await this.client.query(api.quotePdfArtifacts.getForRevision, {
        serviceToken: this.serviceToken,
        quoteId: input.quoteId,
        revision: input.revision,
      });
    } catch {
      fail("quote-pdf-artifact-query-failed");
    }
    if (raw === null) return null;
    const metadata = validateMetadata(raw, input);
    const url = storageUrl(metadata.url);

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: { Accept: PDF_MEDIA_TYPE },
        redirect: "error",
        signal,
      });
    } catch {
      fail("quote-pdf-artifact-download-failed");
    }
    if (response.status !== 200) fail(`quote-pdf-artifact-download-rejected-${response.status}`);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== PDF_MEDIA_TYPE) fail("quote-pdf-artifact-media-type-mismatch");
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== metadata.byteLength)
    ) {
      fail("quote-pdf-artifact-length-mismatch");
    }

    const bytes = await readExactBody(response, metadata.byteLength);
    if (
      bytes[0] !== 0x25 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 ||
      bytes[4] !== 0x2d
    ) {
      fail("quote-pdf-artifact-signature-invalid");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const expectedDigest = PDF_DIGEST_PATTERN.exec(metadata.digest)?.[1];
    if (digest !== expectedDigest) fail("quote-pdf-artifact-digest-mismatch");

    return {
      quoteId: metadata.quoteId,
      revisionId: metadata.revisionId,
      revision: metadata.revision,
      revisionFingerprint: metadata.revisionFingerprint,
      filename: metadata.filename,
      mediaType: PDF_MEDIA_TYPE,
      digest: metadata.digest,
      byteLength: metadata.byteLength,
      bytes,
    };
  }
}
