export type QuoteRevisionStatus = "draft" | "reviewed" | "finalized";
export type QuoteCommercialStatus = "open" | "accepted" | "declined" | "expired";
export type QuoteHistoricalOutcome = Exclude<QuoteCommercialStatus, "open">;
export type QuoteDeliveryStatus =
  "pending" | "executing" | "succeeded" | "failed" | "indeterminate" | "reconciled";

export type QuoteRevisionLineItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export type QuoteAggregate = {
  quoteId: string;
  ownerId: string;
  clientId: string;
  projectId?: string;
  number: string;
  currentRevision: number;
  currentRevisionId: string;
  aggregateVersion: number;
  commercialStatus: QuoteCommercialStatus;
  commercialRevision?: number;
  commercialRecordedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type QuoteRevision = {
  revisionId: string;
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionVersion: number;
  status: QuoteRevisionStatus;
  lineItems: QuoteRevisionLineItem[];
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  currency: "AUD";
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  fingerprint?: string;
  predecessorRevisionId?: string;
  historicalOutcome?: QuoteHistoricalOutcome;
  historicalOutcomeRecordedAt?: number;
  reviewedAt?: number;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type QuoteDeliveryAttempt = {
  deliveryAttemptId: string;
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionId: string;
  revisionFingerprint: string;
  recipient: string;
  channel: "email";
  sendFingerprint: string;
  idempotencyKey: string;
  approvalId: string;
  actionFingerprint: string;
  status: QuoteDeliveryStatus;
  reconciledOutcome?: "succeeded" | "failed";
  provider: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  providerErrorCode?: string;
  createdAt: number;
  executionStartedAt?: number;
  completedAt?: number;
  reconciledAt?: number;
  updatedAt: number;
};

export type QuoteSnapshot = {
  aggregate: QuoteAggregate;
  revision: QuoteRevision;
};

export type QuoteTotals = {
  subtotal: number;
  tax: number;
  total: number;
};

export type QuoteDraftPatch = {
  lineItems?: QuoteRevisionLineItem[];
  taxRate?: number | null;
  validUntil?: string | null;
  notes?: string | null;
  termsIncluded?: boolean;
};

export class QuoteVersionConflictError extends Error {
  constructor(message = "The quote revision version does not match the expected version.") {
    super(message);
    this.name = "QuoteVersionConflictError";
  }
}

export class QuoteInvalidTransitionError extends Error {
  constructor(message = "The requested quote revision transition is not allowed.") {
    super(message);
    this.name = "QuoteInvalidTransitionError";
  }
}

export class QuoteFinalizedImmutableError extends Error {
  constructor(message = "A finalized quote revision is immutable.") {
    super(message);
    this.name = "QuoteFinalizedImmutableError";
  }
}

export class QuoteFingerprintMismatchError extends Error {
  constructor(message = "The quote fingerprint does not match the authoritative revision.") {
    super(message);
    this.name = "QuoteFingerprintMismatchError";
  }
}

export class QuoteDeliveryStateConflictError extends Error {
  constructor(message = "The quote delivery attempt is not in the expected state.") {
    super(message);
    this.name = "QuoteDeliveryStateConflictError";
  }
}

export class QuoteDeliverySendConflictError extends Error {
  constructor(
    message = "A delivery attempt already exists for this quote, revision, recipient, and channel with different send details.",
  ) {
    super(message);
    this.name = "QuoteDeliverySendConflictError";
  }
}

const ALLOWED_REVISION_TRANSITIONS = new Set<string>([
  "draft:reviewed",
  "reviewed:draft",
  "reviewed:finalized",
]);

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function normalizeLineItems(lineItems: readonly QuoteRevisionLineItem[]): QuoteRevisionLineItem[] {
  return lineItems.map((item, index) => {
    const description = item.description.trim();
    if (!description) {
      throw new TypeError(`Line item ${index + 1} description cannot be empty.`);
    }
    return {
      description,
      quantity: requireFiniteNonNegative(item.quantity, `Line item ${index + 1} quantity`),
      unitPrice: requireFiniteNonNegative(item.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

export function computeQuoteTotals(
  lineItems: readonly QuoteRevisionLineItem[],
  taxRate?: number,
): QuoteTotals {
  const normalizedTaxRate =
    taxRate === undefined ? 0 : requireFiniteNonNegative(taxRate, "taxRate");
  if (normalizedTaxRate > 1) {
    throw new TypeError("taxRate must not exceed 1.");
  }
  const subtotal = roundMoney(
    lineItems.reduce(
      (sum, item, index) =>
        sum +
        requireFiniteNonNegative(item.quantity, `Line item ${index + 1} quantity`) *
          requireFiniteNonNegative(item.unitPrice, `Line item ${index + 1} unitPrice`),
      0,
    ),
  );
  const tax = roundMoney(subtotal * normalizedTaxRate);
  return { subtotal, tax, total: roundMoney(subtotal + tax) };
}

export function assertRevisionTransition(from: QuoteRevisionStatus, to: QuoteRevisionStatus): void {
  if (!ALLOWED_REVISION_TRANSITIONS.has(`${from}:${to}`)) {
    throw new QuoteInvalidTransitionError(
      `Quote revision cannot transition from ${from} to ${to}.`,
    );
  }
}

function setOptionalText(value: string | null | undefined, current?: string): string | undefined {
  if (value === undefined) return current;
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function applyDraftPatch(
  revision: QuoteRevision,
  patch: QuoteDraftPatch,
  expectedRevisionVersion: number,
  now = Date.now(),
): QuoteRevision {
  if (revision.status === "finalized") {
    throw new QuoteFinalizedImmutableError();
  }
  if (revision.status !== "draft") {
    throw new QuoteInvalidTransitionError("Only draft quote revisions may be edited.");
  }
  if (revision.revisionVersion !== expectedRevisionVersion) {
    throw new QuoteVersionConflictError();
  }
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new TypeError("Quote draft patch requires at least one changed field.");
  }

  const lineItems =
    patch.lineItems === undefined
      ? revision.lineItems.map((item) => ({ ...item }))
      : normalizeLineItems(patch.lineItems);
  const taxRate =
    patch.taxRate === undefined
      ? revision.taxRate
      : patch.taxRate === null
        ? undefined
        : requireFiniteNonNegative(patch.taxRate, "taxRate");
  if (taxRate !== undefined && taxRate > 1) {
    throw new TypeError("taxRate must not exceed 1.");
  }
  const totals = computeQuoteTotals(lineItems, taxRate);

  const next: QuoteRevision = {
    ...revision,
    lineItems,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    termsIncluded: patch.termsIncluded ?? revision.termsIncluded,
    revisionVersion: revision.revisionVersion + 1,
    updatedAt: now,
  };

  if (taxRate === undefined) delete next.taxRate;
  else next.taxRate = taxRate;

  const validUntil = setOptionalText(patch.validUntil, revision.validUntil);
  if (validUntil === undefined) delete next.validUntil;
  else next.validUntil = validUntil;

  const notes = setOptionalText(patch.notes, revision.notes);
  if (notes === undefined) delete next.notes;
  else next.notes = notes;

  return next;
}
