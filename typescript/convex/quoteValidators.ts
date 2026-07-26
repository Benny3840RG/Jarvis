import { v } from "convex/values";

import {
  applyDraftPatch,
  assertRevisionTransition,
  computeQuoteTotals,
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  type QuoteAggregate,
  type QuoteDraftPatch,
  type QuoteHistoricalOutcome,
  type QuoteRevision,
  type QuoteRevisionLineItem,
  type QuoteRevisionStatus,
  type QuoteSnapshot,
  QuoteVersionConflictError,
} from "../src/quotes/quoteLifecycle.js";

export const quoteCommercialStatusValidator = v.union(
  v.literal("open"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("expired"),
);

export const quoteHistoricalOutcomeValidator = v.union(
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("expired"),
);

export const quoteRevisionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("reviewed"),
  v.literal("finalized"),
);

export const quoteLineItemValidator = v.object({
  description: v.string(),
  quantity: v.number(),
  unitPrice: v.number(),
});

export const quoteAggregateDocumentValidator = v.object({
  _id: v.id("quotes"),
  _creationTime: v.number(),
  ownerId: v.string(),
  quoteId: v.string(),
  clientId: v.string(),
  projectId: v.optional(v.string()),
  number: v.string(),
  currentRevision: v.number(),
  currentRevisionId: v.string(),
  aggregateVersion: v.number(),
  commercialStatus: quoteCommercialStatusValidator,
  commercialRevision: v.optional(v.number()),
  commercialRecordedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const quoteRevisionDocumentValidator = v.object({
  _id: v.id("quoteRevisions"),
  _creationTime: v.number(),
  ownerId: v.string(),
  revisionId: v.string(),
  quoteId: v.string(),
  revision: v.number(),
  revisionVersion: v.number(),
  status: quoteRevisionStatusValidator,
  lineItems: v.array(quoteLineItemValidator),
  subtotal: v.number(),
  taxRate: v.optional(v.number()),
  tax: v.number(),
  total: v.number(),
  currency: v.literal("AUD"),
  validUntil: v.optional(v.string()),
  notes: v.optional(v.string()),
  termsIncluded: v.boolean(),
  fingerprint: v.optional(v.string()),
  predecessorRevisionId: v.optional(v.string()),
  historicalOutcome: v.optional(quoteHistoricalOutcomeValidator),
  historicalOutcomeRecordedAt: v.optional(v.number()),
  reviewedAt: v.optional(v.number()),
  finalizedAt: v.optional(v.number()),
  source: v.optional(v.literal("legacy-migration")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const quoteSnapshotDocumentValidator = v.object({
  aggregate: quoteAggregateDocumentValidator,
  revision: quoteRevisionDocumentValidator,
});

export type BuildInitialQuoteRecordsInput = {
  ownerId: string;
  quoteId: string;
  revisionId: string;
  clientId: string;
  projectId?: string;
  number: string;
  lineItems: QuoteRevisionLineItem[];
  taxRate?: number;
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  now: number;
};

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new TypeError(`${field} cannot be empty.`);
  return cleaned;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function requireVersion(actual: number, expected: number, field: string): void {
  if (!Number.isInteger(expected) || actual !== expected) {
    throw new QuoteVersionConflictError(`${field} does not match the expected version.`);
  }
}

function normalizeLineItems(lineItems: readonly QuoteRevisionLineItem[]): QuoteRevisionLineItem[] {
  return lineItems.map((item, index) => ({
    description: cleanRequiredText(item.description, `Line item ${index + 1} description`),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));
}

function assertCurrentRevision(aggregate: QuoteAggregate, revision: QuoteRevision): void {
  if (
    aggregate.ownerId !== revision.ownerId ||
    aggregate.quoteId !== revision.quoteId ||
    aggregate.currentRevision !== revision.revision ||
    aggregate.currentRevisionId !== revision.revisionId
  ) {
    throw new QuoteVersionConflictError("The quote aggregate no longer points to this revision.");
  }
}

function nextAggregate(aggregate: QuoteAggregate, now: number): QuoteAggregate {
  return {
    ...aggregate,
    aggregateVersion: aggregate.aggregateVersion + 1,
    updatedAt: now,
  };
}

export function buildInitialQuoteRecords(input: BuildInitialQuoteRecordsInput): QuoteSnapshot {
  const ownerId = cleanRequiredText(input.ownerId, "Quote owner ID");
  const quoteId = cleanRequiredText(input.quoteId, "Quote ID");
  const revisionId = cleanRequiredText(input.revisionId, "Quote revision ID");
  const clientId = cleanRequiredText(input.clientId, "Quote client ID");
  const projectId = cleanOptionalText(input.projectId);
  const number = cleanRequiredText(input.number, "Quote number");
  const lineItems = normalizeLineItems(input.lineItems);
  const totals = computeQuoteTotals(lineItems, input.taxRate);
  const validUntil = cleanOptionalText(input.validUntil);
  const notes = cleanOptionalText(input.notes);

  const aggregate: QuoteAggregate = {
    ownerId,
    quoteId,
    clientId,
    ...(projectId === undefined ? {} : { projectId }),
    number,
    currentRevision: 1,
    currentRevisionId: revisionId,
    aggregateVersion: 1,
    commercialStatus: "open",
    createdAt: input.now,
    updatedAt: input.now,
  };
  const revision: QuoteRevision = {
    ownerId,
    quoteId,
    revisionId,
    revision: 1,
    revisionVersion: 1,
    status: "draft",
    lineItems,
    subtotal: totals.subtotal,
    ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
    tax: totals.tax,
    total: totals.total,
    currency: "AUD",
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(notes === undefined ? {} : { notes }),
    termsIncluded: input.termsIncluded,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { aggregate, revision };
}

export function applyQuoteDraftPatch(input: {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  patch: QuoteDraftPatch;
  now: number;
}): QuoteSnapshot {
  assertCurrentRevision(input.aggregate, input.revision);
  requireVersion(
    input.aggregate.aggregateVersion,
    input.expectedAggregateVersion,
    "Quote aggregate version",
  );
  const revision = applyDraftPatch(
    input.revision,
    input.patch,
    input.expectedRevisionVersion,
    input.now,
  );
  return { aggregate: nextAggregate(input.aggregate, input.now), revision };
}

export function transitionQuoteRevision(input: {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  to: QuoteRevisionStatus;
  now: number;
}): QuoteSnapshot {
  assertCurrentRevision(input.aggregate, input.revision);
  requireVersion(
    input.aggregate.aggregateVersion,
    input.expectedAggregateVersion,
    "Quote aggregate version",
  );
  requireVersion(
    input.revision.revisionVersion,
    input.expectedRevisionVersion,
    "Quote revision version",
  );
  if (input.to === "finalized") {
    throw new QuoteInvalidTransitionError("Use finalizeQuoteRevision for finalization.");
  }
  assertRevisionTransition(input.revision.status, input.to);

  const revision: QuoteRevision = {
    ...input.revision,
    status: input.to,
    revisionVersion: input.revision.revisionVersion + 1,
    updatedAt: input.now,
  };
  if (input.to === "reviewed") revision.reviewedAt = input.now;
  else delete revision.reviewedAt;
  return { aggregate: nextAggregate(input.aggregate, input.now), revision };
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Quote fingerprint numbers must be finite.");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = canonicalize(entry);
  }
  return result;
}

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function convexQuoteRevisionFingerprint(
  aggregate: QuoteAggregate,
  revision: QuoteRevision,
): Promise<string> {
  return `quote-revision:v1:sha256:${await sha256Hex({
    ownerId: aggregate.ownerId,
    quoteId: aggregate.quoteId,
    revision: revision.revision,
    clientId: aggregate.clientId,
    projectId: aggregate.projectId,
    number: aggregate.number,
    lineItems: revision.lineItems,
    subtotal: revision.subtotal,
    taxRate: revision.taxRate,
    tax: revision.tax,
    total: revision.total,
    currency: revision.currency,
    validUntil: revision.validUntil,
    notes: revision.notes,
    termsIncluded: revision.termsIncluded,
  })}`;
}

export async function finalizeQuoteRevision(input: {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  now: number;
}): Promise<QuoteSnapshot> {
  assertCurrentRevision(input.aggregate, input.revision);
  requireVersion(
    input.aggregate.aggregateVersion,
    input.expectedAggregateVersion,
    "Quote aggregate version",
  );
  requireVersion(
    input.revision.revisionVersion,
    input.expectedRevisionVersion,
    "Quote revision version",
  );
  if (input.revision.status !== "reviewed") {
    throw new QuoteInvalidTransitionError("Only a reviewed quote revision may be finalized.");
  }
  const fingerprint = await convexQuoteRevisionFingerprint(input.aggregate, input.revision);
  const revision: QuoteRevision = {
    ...input.revision,
    status: "finalized",
    fingerprint,
    finalizedAt: input.now,
    revisionVersion: input.revision.revisionVersion + 1,
    updatedAt: input.now,
  };
  return { aggregate: nextAggregate(input.aggregate, input.now), revision };
}

export function forkFinalizedQuote(input: {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  expectedFingerprint: string;
  newRevisionId: string;
  now: number;
}): QuoteSnapshot {
  assertCurrentRevision(input.aggregate, input.revision);
  requireVersion(
    input.aggregate.aggregateVersion,
    input.expectedAggregateVersion,
    "Quote aggregate version",
  );
  requireVersion(
    input.revision.revisionVersion,
    input.expectedRevisionVersion,
    "Quote revision version",
  );
  if (input.revision.status !== "finalized" || !input.revision.fingerprint) {
    throw new QuoteFinalizedImmutableError("Only a finalized revision can be forked.");
  }
  if (input.revision.fingerprint !== input.expectedFingerprint) {
    throw new QuoteFingerprintMismatchError();
  }

  const revision: QuoteRevision = {
    ownerId: input.revision.ownerId,
    quoteId: input.revision.quoteId,
    revisionId: cleanRequiredText(input.newRevisionId, "New quote revision ID"),
    revision: input.revision.revision + 1,
    revisionVersion: 1,
    status: "draft",
    lineItems: input.revision.lineItems.map((item) => ({ ...item })),
    subtotal: input.revision.subtotal,
    ...(input.revision.taxRate === undefined ? {} : { taxRate: input.revision.taxRate }),
    tax: input.revision.tax,
    total: input.revision.total,
    currency: input.revision.currency,
    ...(input.revision.validUntil === undefined ? {} : { validUntil: input.revision.validUntil }),
    ...(input.revision.notes === undefined ? {} : { notes: input.revision.notes }),
    termsIncluded: input.revision.termsIncluded,
    predecessorRevisionId: input.revision.revisionId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const aggregate: QuoteAggregate = {
    ...input.aggregate,
    currentRevision: revision.revision,
    currentRevisionId: revision.revisionId,
    aggregateVersion: input.aggregate.aggregateVersion + 1,
    commercialStatus: "open",
    updatedAt: input.now,
  };
  delete aggregate.commercialRevision;
  delete aggregate.commercialRecordedAt;
  return { aggregate, revision };
}

export function recordQuoteCommercialOutcome(input: {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
  expectedAggregateVersion: number;
  outcome: QuoteHistoricalOutcome;
  now: number;
}): QuoteSnapshot {
  assertCurrentRevision(input.aggregate, input.revision);
  requireVersion(
    input.aggregate.aggregateVersion,
    input.expectedAggregateVersion,
    "Quote aggregate version",
  );
  if (input.revision.status !== "finalized") {
    throw new QuoteInvalidTransitionError("Commercial outcomes require a finalized revision.");
  }
  if (
    input.revision.historicalOutcome !== undefined &&
    input.revision.historicalOutcome !== input.outcome
  ) {
    throw new QuoteInvalidTransitionError("This quote revision already has another outcome.");
  }

  return {
    aggregate: {
      ...input.aggregate,
      aggregateVersion: input.aggregate.aggregateVersion + 1,
      commercialStatus: input.outcome,
      commercialRevision: input.revision.revision,
      commercialRecordedAt: input.now,
      updatedAt: input.now,
    },
    revision: {
      ...input.revision,
      historicalOutcome: input.outcome,
      historicalOutcomeRecordedAt: input.now,
      revisionVersion: input.revision.revisionVersion + 1,
      updatedAt: input.now,
    },
  };
}
