import { createHash } from "node:crypto";

import type {
  QuoteEmailPrepareInput,
  QuoteEmailPreparedReference,
  QuoteEmailSendAcceptance,
} from "./quoteEmailProvider.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com/v1.0";
const MAX_PDF_BYTES = 2 * 1024 * 1024;
const PDF_DIGEST = /^quote-pdf:v1:sha256:([a-f0-9]{64})$/u;

export type MicrosoftGraphAccessTokenSupplier = (signal: AbortSignal) => Promise<string>;

export type MicrosoftGraphQuoteEmailProviderOptions = {
  mailbox: string;
  getAccessToken: MicrosoftGraphAccessTokenSupplier;
  fetch?: typeof globalThis.fetch;
  graphOrigin?: typeof GRAPH_ORIGIN;
};

export class MicrosoftGraphQuoteEmailProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MicrosoftGraphQuoteEmailProviderError";
  }
}

function fail(code: string): never {
  throw new MicrosoftGraphQuoteEmailProviderError(code);
}

function requiredText(value: string, max: number, code: string): string {
  const cleaned = value.trim();
  const containsControl = Array.from(cleaned).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || point === 127);
  });
  if (!cleaned || cleaned.length > max || containsControl) fail(code);
  return cleaned;
}

function accessToken(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || /[\r\n]/u.test(cleaned)) fail("outlook-graph-authorization-failed");
  return cleaned;
}

function validatePrepareInput(input: QuoteEmailPrepareInput): {
  recipient: string;
  subject: string;
  body: string;
  filename: string;
} {
  if (
    input.revision.status !== "finalized" ||
    input.revision.quoteId !== input.quoteId ||
    !input.revision.fingerprint
  ) {
    fail("outlook-quote-not-finalized");
  }
  const recipient = requiredText(input.recipient, 320, "outlook-recipient-invalid");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(recipient)) fail("outlook-recipient-invalid");
  const subject = requiredText(input.subject, 200, "outlook-subject-invalid");
  const body = requiredText(input.body, 4_000, "outlook-body-invalid");
  const filename = requiredText(input.attachment.filename, 160, "outlook-attachment-invalid");
  if (
    input.attachment.mediaType !== "application/pdf" ||
    input.attachment.bytes.byteLength < 5 ||
    input.attachment.bytes.byteLength > MAX_PDF_BYTES ||
    !filename.toLowerCase().endsWith(".pdf") ||
    /[\\/]/u.test(filename)
  ) {
    fail("outlook-attachment-invalid");
  }
  const match = PDF_DIGEST.exec(input.attachment.digest);
  const actual = createHash("sha256").update(input.attachment.bytes).digest("hex");
  if (!match || match[1] !== actual) fail("outlook-attachment-digest-mismatch");
  return { recipient, subject, body, filename };
}

function validateReference(reference: QuoteEmailPreparedReference): string {
  const id = requiredText(reference.providerRequestId, 1_024, "outlook-message-id-invalid");
  if (reference.providerCorrelationId !== id) fail("outlook-message-reference-invalid");
  return id;
}

export class MicrosoftGraphQuoteEmailProvider {
  readonly name = "microsoft-graph-mail-v1";
  private readonly mailbox: string;
  private readonly getAccessToken: MicrosoftGraphAccessTokenSupplier;
  private readonly fetch: typeof globalThis.fetch;
  private readonly graphOrigin: typeof GRAPH_ORIGIN;

  constructor(options: MicrosoftGraphQuoteEmailProviderOptions) {
    this.mailbox = requiredText(options.mailbox, 320, "outlook-mailbox-invalid");
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.graphOrigin = options.graphOrigin ?? GRAPH_ORIGIN;
  }

  private async token(signal: AbortSignal): Promise<string> {
    try {
      return accessToken(await this.getAccessToken(signal));
    } catch (error: unknown) {
      if (
        error instanceof MicrosoftGraphQuoteEmailProviderError &&
        error.code === "outlook-graph-authorization-failed"
      ) {
        throw error;
      }
      fail("outlook-graph-token-unavailable");
    }
  }

  async prepare(
    input: QuoteEmailPrepareInput,
    signal: AbortSignal,
  ): Promise<QuoteEmailPreparedReference> {
    const validated = validatePrepareInput(input);
    const token = await this.token(signal);
    const url = `${this.graphOrigin}/users/${encodeURIComponent(this.mailbox)}/messages`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: 'IdType="ImmutableId"',
        },
        body: JSON.stringify({
          subject: validated.subject,
          body: { contentType: "Text", content: validated.body },
          toRecipients: [{ emailAddress: { address: validated.recipient } }],
          attachments: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: validated.filename,
              contentType: "application/pdf",
              contentBytes: Buffer.from(input.attachment.bytes).toString("base64"),
              isInline: false,
            },
          ],
        }),
        redirect: "error",
        signal,
      });
    } catch {
      fail("outlook-draft-request-failed");
    }
    if (response.status !== 201) fail(`outlook-draft-rejected-${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail("outlook-draft-response-invalid");
    }
    if (typeof body !== "object" || body === null) fail("outlook-draft-response-invalid");
    const record = body as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !record.id.trim() ||
      record.id.length > 1_024 ||
      record.isDraft !== true
    ) {
      fail("outlook-draft-response-invalid");
    }
    return {
      providerRequestId: record.id,
      providerCorrelationId: record.id,
    };
  }

  async sendPrepared(
    reference: QuoteEmailPreparedReference,
    signal: AbortSignal,
  ): Promise<QuoteEmailSendAcceptance> {
    const immutableMessageId = validateReference(reference);
    const token = await this.token(signal);
    const url =
      `${this.graphOrigin}/users/${encodeURIComponent(this.mailbox)}/messages/` +
      `${encodeURIComponent(immutableMessageId)}/send`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": "0",
          Prefer: 'IdType="ImmutableId"',
        },
        redirect: "error",
        signal,
      });
    } catch {
      fail("outlook-send-request-failed");
    }
    if (response.status !== 202) fail(`outlook-send-rejected-${response.status}`);
    return { status: "accepted" };
  }
}
