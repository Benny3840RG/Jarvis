/**
 * Memory Governance V1 (#838): typed governance metadata, privacy-first
 * retention, read-only inventory, deterministic dry-run retention preview,
 * contradiction review, consent-gated promotion through the existing memory
 * change-set service, and honest deletion receipts.
 *
 * Everything here is pure or delegates to `MemoryChangeSetService.stage`.
 * Nothing in this module deletes, prunes, approves or applies memory, and it
 * introduces no second memory store.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  MemoryAssumption,
  MemoryChangeSet,
  MemoryChangeSetService,
} from "./memoryChangeSets.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MEMORY_CATEGORIES = [
  "working",
  "raw_episode",
  "episodic_summary",
  "inferred_preference",
  "reflection",
  "fact",
  "decision",
  "audit",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const GOVERNED_MEMORY_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "needs_review",
] as const;
export type GovernedMemoryStatus = (typeof GOVERNED_MEMORY_STATUSES)[number];

const isoTimestamp = z.string().refine(
  (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  },
  { message: "must be a canonical UTC ISO timestamp" },
);

const nonEmpty = z.string().trim().min(1);

export const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: nonEmpty }).strict(),
  z.object({ kind: z.literal("session"), sessionId: nonEmpty }).strict(),
  z.object({ kind: z.literal("owner") }).strict(),
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryProvenanceSchema = z
  .object({
    source: z.enum(["user", "file", "tool", "measurement", "inference"]),
    sourceRef: nonEmpty,
    recordedBy: z.enum(["user", "agent", "tool"]),
    /** Identifier of the verified action that earned this memory, when any. */
    verifiedActionRef: nonEmpty.optional(),
  })
  .strict();
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const governedMemoryRecordSchema = z
  .object({
    recordId: nonEmpty,
    purpose: nonEmpty,
    scope: memoryScopeSchema,
    category: z.enum(MEMORY_CATEGORIES),
    content: nonEmpty,
    /** Stable key for contradiction review, e.g. "units.preferred". */
    subjectKey: nonEmpty.optional(),
    /** `null` is allowed so missing provenance is reviewable, not silently dropped. */
    provenance: memoryProvenanceSchema.nullable(),
    consent: z.enum(["not_required", "pending", "granted", "declined", "withdrawn"]),
    /** V1 has no hidden memory: every governed record is user-visible. */
    visibility: z.literal("user_visible"),
    sensitivity: z.enum(["none", "sensitive"]),
    confidence: z.number().finite().min(0).max(1),
    status: z.enum(GOVERNED_MEMORY_STATUSES),
    revision: z.number().int().positive(),
    lineage: z
      .object({
        parentIds: z.array(nonEmpty),
        supersedes: nonEmpty.optional(),
      })
      .strict(),
    createdAt: isoTimestamp,
    /** Optional explicit expiry; it can only shorten the policy window. */
    expiresAt: isoTimestamp.nullable(),
    /** Informational only; use never renews retention. */
    lastUsedAt: isoTimestamp.optional(),
    lastVerifiedAt: isoTimestamp.optional(),
    pinned: z.boolean(),
    hold: z.object({ reason: nonEmpty, placedAt: isoTimestamp }).strict().optional(),
    /** Active records that depend on this one. */
    activeDependents: z.array(nonEmpty),
    /** Existing memory change set that carries this record's consent decision. */
    changeSetId: nonEmpty.optional(),
  })
  .strict();
export type GovernedMemoryRecord = z.infer<typeof governedMemoryRecordSchema>;

export type GovernanceValidation =
  | { ok: true; record: GovernedMemoryRecord }
  | { ok: false; recordId: string | null; issues: string[] };

export function validateGovernedMemoryRecord(input: unknown): GovernanceValidation {
  const parsed = governedMemoryRecordSchema.safeParse(input);
  if (parsed.success) return { ok: true, record: parsed.data };
  const recordId =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { recordId?: unknown }).recordId === "string"
      ? (input as { recordId: string }).recordId
      : null;
  return {
    ok: false,
    recordId,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(record)"}: ${issue.message}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

export type RetentionRule =
  | Readonly<{ kind: "ttl"; ms: number }>
  | Readonly<{ kind: "until_changed" }>
  | Readonly<{ kind: "unconfigured"; note: string }>;

export type RetentionPolicy = Readonly<{
  rules: Readonly<Record<MemoryCategory, RetentionRule>>;
  staleAfterMs: number;
}>;

/** Privacy-first defaults from #838. Audit retention is deliberately unset. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  // Every rule object is frozen too, so callers cannot lengthen the defaults.
  rules: Object.freeze({
    working: Object.freeze({ kind: "ttl", ms: 24 * HOUR_MS }),
    raw_episode: Object.freeze({ kind: "ttl", ms: 30 * DAY_MS }),
    episodic_summary: Object.freeze({ kind: "ttl", ms: 90 * DAY_MS }),
    inferred_preference: Object.freeze({ kind: "ttl", ms: 180 * DAY_MS }),
    reflection: Object.freeze({ kind: "ttl", ms: 180 * DAY_MS }),
    fact: Object.freeze({ kind: "until_changed" }),
    decision: Object.freeze({ kind: "until_changed" }),
    audit: Object.freeze({
      kind: "unconfigured",
      note: "Audit retention awaits legal/operational verification; it is not defaulted.",
    }),
  }) satisfies Record<MemoryCategory, RetentionRule>,
  staleAfterMs: 180 * DAY_MS,
});

/**
 * Audit retention may only be set with an explicit verification reference;
 * other categories may be shortened but never lengthened past the defaults.
 */
export function resolveRetentionPolicy(overrides?: {
  auditRetentionDays?: number;
  auditVerificationRef?: string;
  shortenDays?: Partial<Record<MemoryCategory, number>>;
  staleAfterDays?: number;
}): RetentionPolicy {
  const rules = { ...DEFAULT_RETENTION_POLICY.rules };
  if (overrides?.auditRetentionDays !== undefined) {
    const days = overrides.auditRetentionDays;
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("Audit retention days must be a positive integer.");
    }
    if (!overrides.auditVerificationRef?.trim()) {
      throw new Error("Audit retention needs an explicit verification reference.");
    }
    rules.audit = { kind: "ttl", ms: days * DAY_MS };
  }
  for (const [category, days] of Object.entries(overrides?.shortenDays ?? {})) {
    const key = category as MemoryCategory;
    const current = rules[key];
    if (days === undefined) continue;
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`Retention for ${key} must be positive.`);
    }
    if (current.kind !== "ttl" || days * DAY_MS > current.ms) {
      throw new Error(`Retention for ${key} can only be shortened from a ttl default.`);
    }
    rules[key] = { kind: "ttl", ms: days * DAY_MS };
  }
  const staleAfterDays = overrides?.staleAfterDays;
  if (staleAfterDays !== undefined && (!Number.isFinite(staleAfterDays) || staleAfterDays <= 0)) {
    throw new Error("Stale-after days must be positive.");
  }
  if (
    staleAfterDays !== undefined &&
    staleAfterDays * DAY_MS > DEFAULT_RETENTION_POLICY.staleAfterMs
  ) {
    throw new Error("Stale-after days can only be shortened from the default.");
  }
  return {
    rules,
    staleAfterMs:
      staleAfterDays === undefined
        ? DEFAULT_RETENTION_POLICY.staleAfterMs
        : staleAfterDays * DAY_MS,
  };
}

/**
 * Expiry is measured from creation (or an explicit, shorter expiry).
 * `lastUsedAt` is intentionally ignored: reuse never renews a memory.
 */
export function effectiveExpiry(
  record: GovernedMemoryRecord,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): string | null {
  const rule = policy.rules[record.category];
  const explicit = record.expiresAt === null ? null : Date.parse(record.expiresAt);
  const fromPolicy = rule.kind === "ttl" ? Date.parse(record.createdAt) + rule.ms : null;
  const candidates = [explicit, fromPolicy].filter((value): value is number => value !== null);
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

export function isSensitiveInference(record: GovernedMemoryRecord): boolean {
  if (record.sensitivity !== "sensitive") return false;
  return (
    record.provenance === null ||
    record.provenance.source === "inference" ||
    record.category === "inferred_preference" ||
    record.category === "reflection"
  );
}

// ---------------------------------------------------------------------------
// Contradiction review
// ---------------------------------------------------------------------------

function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "project":
      return `project:${scope.projectId}`;
    case "session":
      return `session:${scope.sessionId}`;
    case "owner":
      return "owner";
  }
}

function normaliseClaim(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export type ClaimReview =
  | { action: "no_conflict" }
  | { action: "duplicate"; matches: string }
  | { action: "mark_for_review"; conflictsWith: string[] };

/**
 * A newer contradictory claim never overwrites: it is marked for review and
 * the existing record is left exactly as it was.
 */
export function reviewIncomingClaim(
  existing: readonly GovernedMemoryRecord[],
  incoming: GovernedMemoryRecord,
): ClaimReview {
  if (!incoming.subjectKey) return { action: "no_conflict" };
  const peers = existing.filter(
    (record) =>
      record.recordId !== incoming.recordId &&
      record.subjectKey === incoming.subjectKey &&
      scopeKey(record.scope) === scopeKey(incoming.scope) &&
      (record.status === "approved" || record.status === "proposed"),
  );
  const claim = normaliseClaim(incoming.content);
  const conflicting = peers.filter((record) => normaliseClaim(record.content) !== claim);
  // Any contradiction wins over a matching peer: a restatement must not let a
  // claim bypass review while another record on the same subject disagrees.
  if (conflicting.length > 0) {
    return {
      action: "mark_for_review",
      conflictsWith: conflicting.map((record) => record.recordId).sort(),
    };
  }
  const same = peers.map((record) => record.recordId).sort()[0];
  if (same !== undefined) return { action: "duplicate", matches: same };
  return { action: "no_conflict" };
}

function contradictionsByRecord(records: readonly GovernedMemoryRecord[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const ordered = [...records].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId),
  );
  ordered.forEach((record, index) => {
    const review = reviewIncomingClaim(ordered.slice(0, index), record);
    if (review.action === "mark_for_review") result.set(record.recordId, review.conflictsWith);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Inventory and dry-run retention preview
// ---------------------------------------------------------------------------

export type RetentionAction =
  | "retain"
  | "would_expire"
  | "expiry_blocked"
  | "would_discard_sensitive"
  | "needs_review"
  | "retain_pending_policy";

export type RetentionReason =
  | "within_retention"
  | "retained_until_changed"
  | "expired"
  | "pinned"
  | "hold"
  | "active_dependents"
  | "sensitive_inference_not_retained"
  | "missing_provenance"
  | "contradiction"
  | "stale"
  | "audit_policy_unconfigured"
  | "invalid_record"
  | "duplicate_record_id";

export type RetentionPreviewItem = {
  recordId: string;
  category: MemoryCategory | null;
  status: GovernedMemoryStatus | null;
  action: RetentionAction;
  reasons: RetentionReason[];
  effectiveExpiry: string | null;
  conflictsWith?: string[];
  issues?: string[];
};

export type RetentionPreview = {
  mode: "dry_run";
  generatedAt: string;
  /** Always zero: the preview never deletes, prunes or mutates anything. */
  deletionsExecuted: 0;
  items: RetentionPreviewItem[];
  summary: Record<RetentionAction, number>;
  digest: string;
};

function previewItem(
  record: GovernedMemoryRecord,
  now: number,
  policy: RetentionPolicy,
  conflicts: Map<string, string[]>,
): RetentionPreviewItem {
  const expiry = effectiveExpiry(record, policy);
  const base = {
    recordId: record.recordId,
    category: record.category,
    status: record.status,
    effectiveExpiry: expiry,
  };

  if (isSensitiveInference(record) && !record.hold) {
    return {
      ...base,
      action: "would_discard_sensitive",
      reasons: ["sensitive_inference_not_retained"],
    };
  }

  const expired = expiry !== null && Date.parse(expiry) <= now;
  if (expired) {
    const blockers: RetentionReason[] = [];
    if (record.pinned) blockers.push("pinned");
    if (record.hold) blockers.push("hold");
    if (record.activeDependents.length > 0) blockers.push("active_dependents");
    if (blockers.length > 0) {
      return { ...base, action: "expiry_blocked", reasons: ["expired", ...blockers] };
    }
    return { ...base, action: "would_expire", reasons: ["expired"] };
  }

  const review: RetentionReason[] = [];
  if (record.provenance === null) review.push("missing_provenance");
  const conflictsWith = conflicts.get(record.recordId);
  if (conflictsWith) review.push("contradiction");
  const verifiedAt = Date.parse(record.lastVerifiedAt ?? record.createdAt);
  if (record.status === "approved" && now - verifiedAt > policy.staleAfterMs) review.push("stale");
  if (review.length > 0) {
    return {
      ...base,
      action: "needs_review",
      reasons: review,
      ...(conflictsWith ? { conflictsWith } : {}),
    };
  }

  const rule = policy.rules[record.category];
  if (rule.kind === "unconfigured") {
    return { ...base, action: "retain_pending_policy", reasons: ["audit_policy_unconfigured"] };
  }
  return {
    ...base,
    action: "retain",
    reasons: [rule.kind === "until_changed" ? "retained_until_changed" : "within_retention"],
  };
}

/**
 * Deterministic: the same records, policy and `now` always yield the same
 * preview and digest, regardless of input order.
 */
export function previewRetention(input: {
  records: readonly unknown[];
  now: string;
  policy?: RetentionPolicy;
}): RetentionPreview {
  const now = Date.parse(isoTimestamp.parse(input.now));
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  const valid: GovernedMemoryRecord[] = [];
  const items: RetentionPreviewItem[] = [];
  for (const raw of input.records) {
    const validation = validateGovernedMemoryRecord(raw);
    if (validation.ok) {
      valid.push(validation.record);
    } else {
      items.push({
        recordId: validation.recordId ?? "(unidentified)",
        category: null,
        status: null,
        action: "needs_review",
        reasons: ["invalid_record"],
        effectiveExpiry: null,
        issues: validation.issues,
      });
    }
  }
  // Records sharing an ID are ambiguous: fail closed and keep them all for
  // review instead of letting input order decide which one is previewed.
  const idCounts = new Map<string, number>();
  for (const record of valid)
    idCounts.set(record.recordId, (idCounts.get(record.recordId) ?? 0) + 1);
  const unique = valid.filter((record) => idCounts.get(record.recordId) === 1);
  for (const record of valid) {
    if (idCounts.get(record.recordId) === 1) continue;
    items.push({
      recordId: record.recordId,
      category: record.category,
      status: record.status,
      action: "needs_review",
      reasons: ["duplicate_record_id"],
      effectiveExpiry: null,
    });
  }
  const conflicts = contradictionsByRecord(unique);
  for (const record of unique) items.push(previewItem(record, now, policy, conflicts));
  // Tie-break on the serialised item so equal IDs never depend on input order.
  const sortKey = (item: RetentionPreviewItem) => JSON.stringify(item);
  items.sort(
    (a, b) =>
      a.recordId.localeCompare(b.recordId) ||
      (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0),
  );

  const summary: Record<RetentionAction, number> = {
    retain: 0,
    would_expire: 0,
    expiry_blocked: 0,
    would_discard_sensitive: 0,
    needs_review: 0,
    retain_pending_policy: 0,
  };
  for (const item of items) summary[item.action] += 1;

  const generatedAt = new Date(now).toISOString();
  const digest = createHash("sha256").update(JSON.stringify({ generatedAt, items })).digest("hex");
  return { mode: "dry_run", generatedAt, deletionsExecuted: 0, items, summary, digest };
}

export type MemoryInventoryEntry = {
  recordId: string;
  purpose: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  status: GovernedMemoryStatus;
  consent: GovernedMemoryRecord["consent"];
  source: MemoryProvenance["source"] | "unknown";
  confidence: number;
  effectiveExpiry: string | null;
  pinned: boolean;
  held: boolean;
};

/**
 * Read-only, user-visible listing of what is remembered and why.
 *
 * This is a projection of caller-supplied records: `status` is shown as given.
 * Callers that need the authoritative proposed-vs-approved state must derive
 * it from the linked change set with `governanceStatusFromChangeSet`.
 */
export function buildMemoryInventory(
  records: readonly GovernedMemoryRecord[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): MemoryInventoryEntry[] {
  return records
    .map((record) => ({
      recordId: record.recordId,
      purpose: record.purpose,
      scope: record.scope,
      category: record.category,
      content: record.content,
      status: record.status,
      consent: record.consent,
      source: record.provenance?.source ?? ("unknown" as const),
      confidence: record.confidence,
      effectiveExpiry: effectiveExpiry(record, policy),
      pinned: record.pinned,
      held: record.hold !== undefined,
    }))
    .sort((a, b) => a.recordId.localeCompare(b.recordId));
}

// ---------------------------------------------------------------------------
// Consent-gated promotion through the existing change-set service
// ---------------------------------------------------------------------------

const PROMOTABLE: ReadonlySet<MemoryCategory> = new Set([
  "inferred_preference",
  "reflection",
  "episodic_summary",
]);

export type PromotionRefusal =
  | "not_promotable_category"
  | "consent_declined"
  | "sensitive_inference"
  | "missing_provenance"
  | "not_project_scoped"
  | "already_linked";

export type PromotionPlan =
  | {
      ok: true;
      stage: Parameters<MemoryChangeSetService["stage"]>[0];
    }
  | { ok: false; refusal: PromotionRefusal };

/**
 * Turns a proposed lesson or preference into a *proposed* memory change set.
 * The record is staged as an unverified assumption, so the existing
 * proposed → approved (by the user) → applied flow carries the consent
 * decision. Nothing is promoted by this function.
 */
export function planPromotion(input: {
  record: GovernedMemoryRecord;
  changeSetId: string;
  requestId: string;
  expectedRevision: number;
  rationale: string;
}): PromotionPlan {
  const { record } = input;
  if (!PROMOTABLE.has(record.category)) return { ok: false, refusal: "not_promotable_category" };
  if (record.consent === "declined" || record.consent === "withdrawn") {
    return { ok: false, refusal: "consent_declined" };
  }
  if (record.sensitivity === "sensitive") return { ok: false, refusal: "sensitive_inference" };
  if (record.provenance === null) return { ok: false, refusal: "missing_provenance" };
  if (record.scope.kind !== "project") return { ok: false, refusal: "not_project_scoped" };
  if (record.changeSetId) return { ok: false, refusal: "already_linked" };

  const assumption: MemoryAssumption = {
    kind: "assumption",
    recordId: `governed-${record.recordId}-r${record.revision}`,
    statement: record.content,
    status: "unverified",
    impact: "low",
  };
  return {
    ok: true,
    stage: {
      changeSetId: input.changeSetId,
      requestId: input.requestId,
      projectId: record.scope.projectId,
      expectedRevision: input.expectedRevision,
      records: [assumption],
      rationale: `${input.rationale.trim()} (purpose: ${record.purpose})`,
      proposedBy: "agent",
    },
  };
}

/** Stages the proposal only. Approval stays with the user via the existing service. */
export async function proposePromotion(
  service: Pick<MemoryChangeSetService, "stage">,
  input: Parameters<typeof planPromotion>[0],
): Promise<{ ok: true; changeSet: MemoryChangeSet } | { ok: false; refusal: PromotionRefusal }> {
  const plan = planPromotion(input);
  if (!plan.ok) return plan;
  const changeSet = await service.stage(plan.stage);
  if (changeSet.state !== "proposed") {
    throw new Error(
      `Promotion staging returned state ${changeSet.state}; expected an unapproved proposal.`,
    );
  }
  return { ok: true, changeSet };
}

/**
 * Proposed versus approved is derived only from the linked change set, never
 * from the record's own claim.
 */
export function governanceStatusFromChangeSet(
  changeSet: MemoryChangeSet | null,
): GovernedMemoryStatus {
  if (changeSet === null) return "proposed";
  switch (changeSet.state) {
    case "proposed":
      return "proposed";
    case "rejected":
      return "rejected";
    case "approved":
    case "applied":
      return changeSet.approvedBy === "user" ? "approved" : "needs_review";
  }
}

// ---------------------------------------------------------------------------
// Honest deletion receipts
// ---------------------------------------------------------------------------

export type DeletionStoreStatus =
  "not_attempted" | "deleted_verified" | "deletion_unverified" | "not_covered";

export type DeletionReceiptEntry = {
  recordId: string;
  primaryStore: DeletionStoreStatus;
  backups: "not_covered";
  derivedIndexesAndCaches: "not_covered";
  verifiedAt?: string;
};

export type DeletionReceipt = {
  previewDigest: string;
  executed: boolean;
  statement: string;
  entries: DeletionReceiptEntry[];
  limits: string[];
};

export const DELETION_LIMITS: readonly string[] = Object.freeze([
  "Backup archives already written (archive v4 captures memory history) are not modified; a removed record can remain in earlier archives until the owner deletes them.",
  "Any retention or history kept by the hosted Convex deployment is unverified and outside this receipt.",
  "Logs and prompt context derived from a record are not traced. No search or embedding index existed at the V1 base; if one is added it must be covered separately.",
  "A record is reported deleted only after a read-back confirms it is absent from the primary store.",
]);

/**
 * Builds a receipt for the records a preview would remove. Without read-back
 * evidence every entry stays `not_attempted` (dry run) or
 * `deletion_unverified`; backups and derived stores are never claimed.
 */
export function buildDeletionReceipt(input: {
  preview: RetentionPreview;
  executed: boolean;
  readBack?: Readonly<Record<string, { absent: boolean; checkedAt: string }>>;
}): DeletionReceipt {
  const targets = input.preview.items.filter(
    (item) => item.action === "would_expire" || item.action === "would_discard_sensitive",
  );
  const entries = targets.map((item): DeletionReceiptEntry => {
    const evidence = input.readBack?.[item.recordId];
    let primaryStore: DeletionStoreStatus = "not_attempted";
    if (input.executed)
      primaryStore = evidence?.absent ? "deleted_verified" : "deletion_unverified";
    return {
      recordId: item.recordId,
      primaryStore,
      backups: "not_covered",
      derivedIndexesAndCaches: "not_covered",
      ...(primaryStore === "deleted_verified" && evidence
        ? { verifiedAt: evidence.checkedAt }
        : {}),
    };
  });
  const verified = entries.filter((entry) => entry.primaryStore === "deleted_verified").length;
  const statement = input.executed
    ? `${verified} of ${entries.length} record(s) confirmed absent from the primary store; backups and derived stores not covered.`
    : `Dry run: no deletion was performed. ${entries.length} record(s) would be removed from the primary store.`;
  return {
    previewDigest: input.preview.digest,
    executed: input.executed,
    statement,
    entries,
    limits: [...DELETION_LIMITS],
  };
}
