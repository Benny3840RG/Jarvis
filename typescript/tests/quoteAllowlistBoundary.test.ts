import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import type {
  QuoteEmailPrepareInput,
  QuoteEmailPreparedReference,
  QuoteEmailProvider,
  QuoteEmailSendAcceptance,
} from "../src/quotes/quoteEmailProvider.js";
import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type { QuotePdfArtifactRepository } from "../src/quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import type {
  BindQuoteProviderReferenceInput,
  CompleteQuoteDeliveryInput,
  CreateQuoteDeliveryInput,
  ListQuoteDeliveriesInput,
  MarkQuoteDeliveryIndeterminateInput,
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
  QuoteSendScope,
  ReconcileQuoteDeliveryInput,
  StartQuoteDeliveryInput,
} from "../src/quotes/quoteDeliveryRepository.js";
import type { NoteStore } from "../src/notes/note.js";
import type { ControlledTaskStore } from "../src/tasks/controlledTask.js";
import type { ControlledReminderStore } from "../src/reminders/controlledReminder.js";

function unusedNoteStore(): NoteStore {
  return {
    async create() {
      throw new Error("not used in this test");
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async remove() {
      return null;
    },
  };
}

function unusedQuoteRepository(): QuoteRepository {
  return {
    async createQuote(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async getQuote(): Promise<QuoteSnapshot | null> {
      throw new Error("not used in this test");
    },
    async listQuotes(): Promise<QuoteSummary[]> {
      throw new Error("not used in this test");
    },
    async updateDraft(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async submitForReview(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async reopenForEditing(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async finalizeRevision(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async createRevisionFromFinalized(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async recordCommercialOutcome(): Promise<QuoteSnapshot> {
      throw new Error("not used in this test");
    },
    async cleanup(): Promise<boolean> {
      throw new Error("not used in this test");
    },
  };
}

function unusedEmailProvider(): QuoteEmailProvider {
  return {
    name: "unused-provider",
    async prepare(_input: QuoteEmailPrepareInput): Promise<QuoteEmailPreparedReference> {
      throw new Error("not used in this test");
    },
    async sendPrepared(): Promise<QuoteEmailSendAcceptance> {
      throw new Error("not used in this test");
    },
  };
}

function unusedDeliveryRepository(): QuoteDeliveryRepository {
  return {
    async getBySendScope(_input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null> {
      throw new Error("not used in this test");
    },
    async createPending(_input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async markExecuting(_input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async bindProviderReference(
      _input: BindQuoteProviderReferenceInput,
    ): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async complete(_input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async markIndeterminate(
      _input: MarkQuoteDeliveryIndeterminateInput,
    ): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async reconcile(_input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
      throw new Error("not used in this test");
    },
    async listForQuote(_input: ListQuoteDeliveriesInput): Promise<QuoteDeliveryAttempt[]> {
      throw new Error("not used in this test");
    },
    async cleanup(_quoteId: string): Promise<boolean> {
      throw new Error("not used in this test");
    },
  };
}

function unusedPdfArtifacts(): QuotePdfArtifactRepository {
  return {
    async getForRevision() {
      throw new Error("not used in this test");
    },
  };
}

function unusedTaskStore(): ControlledTaskStore {
  return {
    async create() {
      throw new Error("not used in this test");
    },
    async complete() {
      throw new Error("not used in this test");
    },
    async get() {
      throw new Error("not used in this test");
    },
    async cleanup() {
      throw new Error("not used in this test");
    },
  };
}

function unusedReminderStore(): ControlledReminderStore {
  return {
    async create() {
      throw new Error("not used in this test");
    },
    async cancel() {
      throw new Error("not used in this test");
    },
    async get() {
      throw new Error("not used in this test");
    },
    async cleanup() {
      throw new Error("not used in this test");
    },
  };
}

describe("AM-012/AM-013 governance boundary", () => {
  it("never allowlists quotes:finalize, no matter what stores are supplied", () => {
    const definitions = createToolExecutionDefinitions(
      unusedNoteStore(),
      unusedTaskStore(),
      unusedReminderStore(),
      unusedQuoteRepository(),
      unusedEmailProvider(),
      unusedDeliveryRepository(),
      unusedPdfArtifacts(),
    );

    assert.equal(
      definitions.some(({ tool, operation }) => `${tool}:${operation}` === "quotes:finalize"),
      false,
    );
  });

  it("only allowlists quotes:send when every one of its four gates is supplied", () => {
    const withEverythingElse = createToolExecutionDefinitions(
      unusedNoteStore(),
      unusedTaskStore(),
      unusedReminderStore(),
      unusedQuoteRepository(),
      undefined,
      unusedDeliveryRepository(),
      unusedPdfArtifacts(),
    );
    assert.equal(
      withEverythingElse.some(({ tool, operation }) => `${tool}:${operation}` === "quotes:send"),
      false,
    );

    const withAllFour = createToolExecutionDefinitions(
      unusedNoteStore(),
      unusedTaskStore(),
      unusedReminderStore(),
      unusedQuoteRepository(),
      unusedEmailProvider(),
      unusedDeliveryRepository(),
      unusedPdfArtifacts(),
    );
    assert.equal(
      withAllFour.some(({ tool, operation }) => `${tool}:${operation}` === "quotes:send"),
      true,
    );
  });

  it("never allowlists quotes:finalize or quotes:send with no quote wiring supplied at all", () => {
    const definitions = createToolExecutionDefinitions(unusedNoteStore());
    assert.equal(
      definitions.some(({ tool }) => tool === "quotes"),
      false,
    );
  });
});
