import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createQuoteSendToolDefinition } from "../src/actions/quoteSendTool.js";
import type { ToolExecutionContext } from "../src/actions/toolExecution.js";
import {
  QuoteEmailAcceptedIndeterminateError,
  type PreparedQuoteEmailProvider,
} from "../src/quotes/quoteEmailDeliveryProtocol.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../src/quotes/quoteDeliveryRepository.js";
import type { QuotePdfArtifactRepository } from "../src/quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository } from "../src/quotes/quoteRepository.js";

const REVISION_FINGERPRINT = `quote-revision:v1:sha256:${"a".repeat(64)}`;
const PDF_DIGEST =
  "quote-pdf:v1:sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b";

function delivery(status: QuoteDeliveryAttempt["status"]): QuoteDeliveryAttempt {
  return {
    deliveryAttemptId: "delivery-1",
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    revisionId: "revision-1",
    revisionFingerprint: REVISION_FINGERPRINT,
    recipient: "client@example.com",
    channel: "email",
    sendFingerprint: "send-fingerprint",
    idempotencyKey: "execute-1",
    approvalId: "approval-1",
    actionFingerprint: "action-fingerprint",
    status,
    provider: "microsoft-graph-mail-v1",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("prepared quote send tool composition", () => {
  it("loads the locked PDF and persists the immutable draft ID before send", async () => {
    const events: string[] = [];
    const quotes = {
      async getQuote() {
        return {
          aggregate: {
            quoteId: "quote-1",
            ownerId: "owner-1",
            clientId: "client-1",
            number: "Q-1",
            currentRevision: 1,
            currentRevisionId: "revision-1",
            aggregateVersion: 3,
            commercialStatus: "open",
            createdAt: 1,
            updatedAt: 2,
          },
          revision: {
            revisionId: "revision-1",
            ownerId: "owner-1",
            quoteId: "quote-1",
            revision: 1,
            revisionVersion: 2,
            status: "finalized",
            lineItems: [{ description: "Fence", quantity: 1, unitPrice: 100 }],
            subtotal: 100,
            tax: 10,
            total: 110,
            currency: "AUD",
            termsIncluded: true,
            fingerprint: REVISION_FINGERPRINT,
            finalizedAt: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        };
      },
    } as unknown as QuoteRepository;
    const artifacts: QuotePdfArtifactRepository = {
      async getForRevision() {
        events.push("artifact");
        return {
          quoteId: "quote-1",
          revisionId: "revision-1",
          revision: 1,
          revisionFingerprint: REVISION_FINGERPRINT,
          filename: "Quote-Q-1-R1.pdf",
          mediaType: "application/pdf",
          digest: PDF_DIGEST,
          byteLength: 8,
          bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
        };
      },
    };
    const deliveries = {
      async getBySendScope() {
        return null;
      },
      async createPending() {
        events.push("pending");
        return delivery("pending");
      },
      async markExecuting() {
        events.push("executing");
        return delivery("executing");
      },
      async bindProviderReference(input: { providerRequestId: string }) {
        events.push(`bind:${input.providerRequestId}`);
        return {
          ...delivery("executing"),
          providerRequestId: input.providerRequestId,
          providerCorrelationId: input.providerRequestId,
        };
      },
      async markIndeterminate() {
        events.push("indeterminate");
        return delivery("indeterminate");
      },
      async complete() {
        events.push("complete");
        return delivery("failed");
      },
    } as unknown as QuoteDeliveryRepository;
    const provider: PreparedQuoteEmailProvider = {
      name: "microsoft-graph-mail-v1",
      async prepare(input) {
        events.push(`prepare:${input.attachment.filename}`);
        assert.deepEqual(
          input.attachment.bytes,
          Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
        );
        return {
          providerRequestId: "immutable-message-1",
          providerCorrelationId: "immutable-message-1",
        };
      },
      async sendPrepared() {
        events.push("send");
        return { status: "accepted" };
      },
    };
    const context: ToolExecutionContext = {
      action: {
        actionId: "action-1",
        requestId: "request-1",
        projectId: "project-1",
        baseRevision: 1,
        state: "approved",
        tool: "quotes",
        operation: "send",
        arguments: {},
        rationale: "Send approved quote",
        requiredAuthority: "T2",
        destructive: false,
        idempotencyKey: "proposal-1",
        proposedBy: "agent",
        approvedBy: "user",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
        approvedAt: "2026-07-28T00:00:00.000Z",
      },
      idempotencyKey: "execute-1",
      actionFingerprint: "action-fingerprint",
      effectFingerprint: "effect-fingerprint",
      correlationId: "correlation-1",
      source: "test",
      approvalId: "approval-1",
      policyVersion: "totality-policy:v1",
      async registerProviderAttempt(reference) {
        events.push(`register:${reference.providerRequestId}`);
      },
    };

    const definition = createQuoteSendToolDefinition(quotes, provider, deliveries, artifacts);
    await assert.rejects(
      definition.execute(
        {
          quoteId: "quote-1",
          quoteRevision: 1,
          recipient: "client@example.com",
          deliveryChannel: "email",
          expectedRevisionFingerprint: REVISION_FINGERPRINT,
        },
        new AbortController().signal,
        context,
      ),
      (error: unknown) => error instanceof QuoteEmailAcceptedIndeterminateError,
    );

    assert.deepEqual(events, [
      "artifact",
      "pending",
      "executing",
      "prepare:Quote-Q-1-R1.pdf",
      "bind:immutable-message-1",
      "register:immutable-message-1",
      "send",
      "indeterminate",
    ]);
  });
});
