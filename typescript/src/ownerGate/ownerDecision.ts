// Owner decision queue (#801): the canonical manifest of owner-gated decisions,
// the digest each decision is bound to, and the status derived from the
// append-only ledger. Pure: no I/O, no clock of its own.
//
// A recorded decision is the owner's answer and nothing more. It executes
// nothing and replaces no existing gate: ToolAction approval, CI, review,
// credentials and deployment controls stay authoritative for the work itself.

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";

export const OWNER_DECISION_STATUSES = [
  "NOT_READY",
  "READY",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "EXPIRED",
  "EXECUTED",
] as const;
export type OwnerDecisionStatus = (typeof OWNER_DECISION_STATUSES)[number];

export const OWNER_DECISION_CHOICES = ["approve", "request-changes", "reject"] as const;
export type OwnerDecisionChoice = (typeof OWNER_DECISION_CHOICES)[number];

export const OWNER_DECISION_ENVIRONMENTS = ["repository", "development", "production"] as const;
export type OwnerDecisionEnvironment = (typeof OWNER_DECISION_ENVIRONMENTS)[number];

/** Gates that always need a separate typed confirmation and never a blanket approve. */
export const HIGH_RISK_KINDS = [
  "production-deployment",
  "remote-exposure",
  "hardware-actuation",
  "destructive",
  "customer-send",
] as const;
export type HighRiskKind = (typeof HIGH_RISK_KINDS)[number];

export const EXECUTION_STATUSES = ["executed", "failed", "indeterminate"] as const;
export type OwnerExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * One piece of proof, pinned like a subject so an edited or deleted proof
 * cannot be approved against. Its link is derived from the pin, never typed.
 */
export type OwnerDecisionEvidence = Readonly<{ label: string; pin: OwnerDecisionSubject }>;

/**
 * One thing a decision is about, pinned to the exact revision the card was
 * written against. A pull request and a branch are pinned to a commit; an issue
 * is pinned to its last-updated time, so a new comment or edit (new evidence,
 * a changed requirement) makes the card stale.
 */
export type OwnerDecisionSubject = Readonly<
  | { kind: "pull-request"; number: number; revision: string }
  | { kind: "issue"; number: number; revision: string }
  | { kind: "branch"; name: string; revision: string }
  /** A comment on issue or pull request `on`, pinned to its last-updated time. */
  | { kind: "comment"; id: number; on: number; revision: string }
>;

export function subjectLabel(subject: OwnerDecisionSubject): string {
  if (subject.kind === "branch") return `branch ${subject.name}`;
  if (subject.kind === "comment") return `comment ${subject.id} on #${subject.on}`;
  return `${subject.kind === "issue" ? "issue" : "pull request"} #${subject.number}`;
}

/** The page a subject or proof lives at. */
export function subjectUrl(repository: string, subject: OwnerDecisionSubject): string {
  const base = `https://github.com/${repository}`;
  if (subject.kind === "branch") return `${base}/tree/${subject.name}`;
  if (subject.kind === "pull-request") return `${base}/pull/${subject.number}`;
  if (subject.kind === "issue") return `${base}/issues/${subject.number}`;
  return `${base}/issues/${subject.on}#issuecomment-${subject.id}`;
}

/** Everything that must be unchanged for a card to be approved: subjects and proof. */
export function pinsOf(entry: OwnerDecisionEntry): OwnerDecisionSubject[] {
  const seen = new Set<string>();
  return [...entry.subjects, ...entry.evidence.map((item) => item.pin)].filter((pin) => {
    const key = JSON.stringify(pin);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type OwnerDecisionEntry = Readonly<{
  id: string;
  title: string;
  issues: readonly number[];
  proposedAction: string;
  consequence: string;
  scope: string;
  environment: OwnerDecisionEnvironment;
  risk: "standard" | "high";
  highRiskKind?: HighRiskKind;
  subjects: readonly OwnerDecisionSubject[];
  dependsOn: readonly string[];
  evidence: readonly OwnerDecisionEvidence[];
  /** What is still missing before the owner can usefully decide. Empty means ready. */
  missingPrerequisites: readonly string[];
  rollback: string;
  expiresAt: string;
}>;

export type OwnerDecisionManifest = Readonly<{
  version: 1;
  repository: string;
  decisions: readonly OwnerDecisionEntry[];
  /** Open items deliberately left out of the queue, with the reason. */
  excluded: readonly Readonly<{ issue: number; reason: string }>[];
}>;

export class OwnerDecisionManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = 2000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new OwnerDecisionManifestError(`${field} must be non-empty text.`);
  }
  return value;
}

function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new OwnerDecisionManifestError(`${field} must be a list.`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new OwnerDecisionManifestError(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OwnerDecisionManifestError(`${field} has an unexpected field ${key}.`);
    }
  }
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parseSubject(raw: unknown, field: string): OwnerDecisionSubject {
  if (!isRecord(raw)) throw new OwnerDecisionManifestError(`${field} must be an object.`);
  const kind = oneOf(
    raw.kind,
    ["pull-request", "issue", "branch", "comment"] as const,
    `${field}.kind`,
  );
  const revision = text(raw.revision, `${field}.revision`, 40);
  if (kind === "issue" || kind === "comment") {
    if (!ISO_SECONDS_PATTERN.test(revision) || !Number.isFinite(Date.parse(revision))) {
      throw new OwnerDecisionManifestError(`${field}.revision must be a last-updated time.`);
    }
  } else if (!SHA_PATTERN.test(revision)) {
    throw new OwnerDecisionManifestError(`${field}.revision must be a full commit SHA.`);
  }
  if (kind === "branch") {
    exactKeys(raw, ["kind", "name", "revision"], field);
    const name = text(raw.name, `${field}.name`, 100);
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
      throw new OwnerDecisionManifestError(`${field}.name is not a branch name.`);
    }
    return { kind, name, revision };
  }
  const positive = (value: unknown, name: string): number => {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new OwnerDecisionManifestError(`${field}.${name} must be a positive integer.`);
    }
    return value as number;
  };
  if (kind === "comment") {
    exactKeys(raw, ["kind", "id", "on", "revision"], field);
    return { kind, id: positive(raw.id, "id"), on: positive(raw.on, "on"), revision };
  }
  exactKeys(raw, ["kind", "number", "revision"], field);
  if (!Number.isInteger(raw.number) || (raw.number as number) <= 0) {
    throw new OwnerDecisionManifestError(`${field}.number must be a positive integer.`);
  }
  return { kind, number: raw.number as number, revision };
}

function parseEntry(raw: unknown, index: number): OwnerDecisionEntry {
  const field = `decisions[${index}]`;
  if (!isRecord(raw)) throw new OwnerDecisionManifestError(`${field} must be an object.`);
  exactKeys(
    raw,
    [
      "id",
      "title",
      "issues",
      "proposedAction",
      "consequence",
      "scope",
      "environment",
      "risk",
      "highRiskKind",
      "subjects",
      "dependsOn",
      "evidence",
      "missingPrerequisites",
      "rollback",
      "expiresAt",
    ],
    field,
  );
  const id = text(raw.id, `${field}.id`, 80);
  if (!ID_PATTERN.test(id)) {
    throw new OwnerDecisionManifestError(`${field}.id must be lower-case words joined by hyphens.`);
  }
  if (
    !Array.isArray(raw.issues) ||
    raw.issues.length === 0 ||
    !raw.issues.every((issue) => Number.isInteger(issue) && (issue as number) > 0)
  ) {
    throw new OwnerDecisionManifestError(`${field}.issues must list issue numbers.`);
  }
  const environment = oneOf(raw.environment, OWNER_DECISION_ENVIRONMENTS, `${field}.environment`);
  const risk = oneOf(raw.risk, ["standard", "high"] as const, `${field}.risk`);
  const highRiskKind =
    raw.highRiskKind === undefined
      ? undefined
      : oneOf(raw.highRiskKind, HIGH_RISK_KINDS, `${field}.highRiskKind`);
  if ((risk === "high") !== (highRiskKind !== undefined)) {
    throw new OwnerDecisionManifestError(
      `${field} must set highRiskKind exactly when risk is high.`,
    );
  }
  if (environment === "production" && risk !== "high") {
    throw new OwnerDecisionManifestError(`${field} targets production and must be high risk.`);
  }
  if (!Array.isArray(raw.subjects) || raw.subjects.length === 0) {
    throw new OwnerDecisionManifestError(`${field}.subjects must list at least one subject.`);
  }
  const subjects = raw.subjects.map((item, subjectIndex) =>
    parseSubject(item, `${field}.subjects[${subjectIndex}]`),
  );
  if (!Array.isArray(raw.evidence)) {
    throw new OwnerDecisionManifestError(`${field}.evidence must be a list.`);
  }
  const evidence = raw.evidence.map((item, evidenceIndex) => {
    const evidenceField = `${field}.evidence[${evidenceIndex}]`;
    if (!isRecord(item))
      throw new OwnerDecisionManifestError(`${evidenceField} must be an object.`);
    exactKeys(item, ["label", "pin"], evidenceField);
    const pin = parseSubject(item.pin, `${evidenceField}.pin`);
    if (pin.kind === "branch") {
      throw new OwnerDecisionManifestError(`${evidenceField}.pin cannot be a branch.`);
    }
    return { label: text(item.label, `${evidenceField}.label`, 200), pin };
  });
  const expiresAt = text(raw.expiresAt, `${field}.expiresAt`, 40);
  if (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt) {
    throw new OwnerDecisionManifestError(`${field}.expiresAt must be an ISO-8601 UTC timestamp.`);
  }
  return {
    id,
    title: text(raw.title, `${field}.title`, 200),
    issues: raw.issues as number[],
    proposedAction: text(raw.proposedAction, `${field}.proposedAction`),
    consequence: text(raw.consequence, `${field}.consequence`),
    scope: text(raw.scope, `${field}.scope`),
    environment,
    risk,
    ...(highRiskKind === undefined ? {} : { highRiskKind }),
    subjects,
    dependsOn: textList(raw.dependsOn, `${field}.dependsOn`),
    evidence,
    missingPrerequisites: textList(raw.missingPrerequisites, `${field}.missingPrerequisites`),
    rollback: text(raw.rollback, `${field}.rollback`),
    expiresAt,
  };
}

/** Strictly validates a manifest. Any defect rejects the whole manifest. */
export function parseOwnerDecisionManifest(raw: unknown): OwnerDecisionManifest {
  if (!isRecord(raw)) throw new OwnerDecisionManifestError("Manifest must be an object.");
  exactKeys(raw, ["version", "repository", "decisions", "excluded"], "manifest");
  if (raw.version !== 1) throw new OwnerDecisionManifestError("Manifest version must be 1.");
  const repository = text(raw.repository, "repository", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new OwnerDecisionManifestError("repository must be owner/name.");
  }
  if (!Array.isArray(raw.decisions)) {
    throw new OwnerDecisionManifestError("decisions must be a list.");
  }
  const decisions = raw.decisions.map((entry, index) => parseEntry(entry, index));
  const ids = new Set<string>();
  for (const entry of decisions) {
    if (ids.has(entry.id)) throw new OwnerDecisionManifestError(`Duplicate decision ${entry.id}.`);
    ids.add(entry.id);
  }
  const byId = new Map(decisions.map((entry) => [entry.id, entry]));
  const visiting = new Set<string>();
  const cleared = new Set<string>();
  const walk = (id: string): void => {
    if (cleared.has(id)) return;
    if (visiting.has(id)) throw new OwnerDecisionManifestError(`Dependency cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if (!byId.has(dependency)) {
        throw new OwnerDecisionManifestError(`${id} depends on unknown decision ${dependency}.`);
      }
      walk(dependency);
    }
    visiting.delete(id);
    cleared.add(id);
  };
  for (const entry of decisions) walk(entry.id);
  if (!Array.isArray(raw.excluded)) {
    throw new OwnerDecisionManifestError("excluded must be a list.");
  }
  const excluded = raw.excluded.map((item, index) => {
    if (!isRecord(item) || !Number.isInteger(item.issue) || (item.issue as number) <= 0) {
      throw new OwnerDecisionManifestError(`excluded[${index}] must name an issue.`);
    }
    exactKeys(item, ["issue", "reason"], `excluded[${index}]`);
    return { issue: item.issue as number, reason: text(item.reason, `excluded[${index}].reason`) };
  });
  return { version: 1, repository, decisions, excluded };
}

/**
 * The digest a decision is bound to: every field of the entry, including the
 * subject SHA, environment and expiry. Any change to the card produces a new
 * digest, and a decision recorded against the old one no longer applies.
 */
export function ownerDecisionDigest(entry: OwnerDecisionEntry): string {
  return sha256Hex(canonicalJson(entry));
}

/** The phrase the owner must type to approve a high-risk decision. */
export function confirmationPhrase(entry: OwnerDecisionEntry): string {
  return `APPROVE ${entry.id}`;
}

export type OwnerDecisionRecord = Readonly<{
  sequence: number;
  recordId: string;
  kind: "decision" | "execution";
  decisionId: string;
  actionDigest: string;
  subjects: readonly OwnerDecisionSubject[];
  environment: OwnerDecisionEnvironment;
  decision?: OwnerDecisionChoice;
  execution?: Readonly<{ status: OwnerExecutionStatus; reference?: string }>;
  note?: string;
  actor: string;
  idempotencyKey: string;
  /** Digest of the request that produced this record, for replay detection. */
  requestDigest: string;
  recordedAt: string;
  previousHash: string;
  hash: string;
}>;

export const LEDGER_GENESIS_HASH = "0".repeat(64);

export function ownerDecisionRecordHash(record: Omit<OwnerDecisionRecord, "hash">): string {
  return sha256Hex(canonicalJson(record));
}

/** Confirms sequence numbers and the hash chain. Throws on any break. */
export function assertLedgerIntact(records: readonly OwnerDecisionRecord[]): void {
  let previousHash = LEDGER_GENESIS_HASH;
  records.forEach((record, index) => {
    const { hash, ...rest } = record;
    if (
      record.sequence !== index + 1 ||
      record.previousHash !== previousHash ||
      ownerDecisionRecordHash(rest) !== hash
    ) {
      throw new Error(`Owner decision ledger is not intact at record ${index + 1}.`);
    }
    previousHash = hash;
  });
}

export type OwnerDecisionCard = Readonly<{
  entry: OwnerDecisionEntry;
  actionDigest: string;
  status: OwnerDecisionStatus;
  /** Plain reasons the card is not ready or cannot be approved now. */
  blockedBy: readonly string[];
  /** Where each subject and each piece of proof can be read. */
  links: Readonly<{
    subjects: readonly Readonly<{ label: string; url: string; revision: string }>[];
    evidence: readonly Readonly<{ label: string; url: string; revision: string }>[];
  }>;
  /** Present only for high-risk cards. */
  confirmationPhrase?: string;
  decision?: Readonly<{
    choice: OwnerDecisionChoice;
    recordedAt: string;
    actor: string;
    note?: string;
  }>;
  execution?: Readonly<{ status: OwnerExecutionStatus; recordedAt: string; reference?: string }>;
  /** Decisions recorded against an earlier version of this card. They no longer apply. */
  supersededDecisions: number;
}>;

/** Derives every card's status from the manifest, the ledger and the time. */
export function deriveOwnerDecisionCards(
  manifest: OwnerDecisionManifest,
  records: readonly OwnerDecisionRecord[],
  nowMs: number,
): OwnerDecisionCard[] {
  const cards = new Map<string, OwnerDecisionCard>();
  const byId = new Map(manifest.decisions.map((entry) => [entry.id, entry]));

  const derive = (entry: OwnerDecisionEntry): OwnerDecisionCard => {
    const known = cards.get(entry.id);
    if (known) return known;
    const actionDigest = ownerDecisionDigest(entry);
    const mine = records.filter((record) => record.decisionId === entry.id);
    const current = mine.filter((record) => record.actionDigest === actionDigest);
    const newestFirst = [...current].reverse();
    const lastDecision = newestFirst.find((record) => record.kind === "decision");
    // Execution reports belong to the most recent approval. They stay on the
    // card after a later rejection so an unresolved or failed effect is never
    // hidden by a change of mind.
    const lastApproval = newestFirst.find(
      (record) => record.kind === "decision" && record.decision === "approve",
    );
    const lastExecution =
      lastApproval === undefined
        ? undefined
        : newestFirst.find(
            (record) => record.kind === "execution" && record.sequence > lastApproval.sequence,
          );
    const expired = nowMs > Date.parse(entry.expiresAt);

    const blockedBy = [...entry.missingPrerequisites];
    if (entry.evidence.length === 0) blockedBy.push("No evidence is attached to this card.");
    for (const dependencyId of entry.dependsOn) {
      const dependency = derive(byId.get(dependencyId)!);
      if (dependency.status !== "APPROVED" && dependency.status !== "EXECUTED") {
        blockedBy.push(`Depends on "${dependency.entry.title}", which is ${dependency.status}.`);
      }
    }

    let status: OwnerDecisionStatus;
    if (lastDecision?.decision === "approve") {
      if (lastExecution?.execution?.status === "executed") status = "EXECUTED";
      else status = expired ? "EXPIRED" : "APPROVED";
    } else if (lastDecision?.decision === "reject") status = "REJECTED";
    else if (lastDecision?.decision === "request-changes") status = "CHANGES_REQUESTED";
    else if (blockedBy.length > 0) status = "NOT_READY";
    else status = expired ? "EXPIRED" : "READY";

    const card: OwnerDecisionCard = {
      entry,
      actionDigest,
      status,
      blockedBy,
      links: {
        subjects: entry.subjects.map((subject) => ({
          label: subjectLabel(subject),
          url: subjectUrl(manifest.repository, subject),
          revision: subject.revision,
        })),
        evidence: entry.evidence.map((item) => ({
          label: item.label,
          url: subjectUrl(manifest.repository, item.pin),
          revision: item.pin.revision,
        })),
      },
      ...(entry.risk === "high" ? { confirmationPhrase: confirmationPhrase(entry) } : {}),
      ...(lastDecision?.decision === undefined
        ? {}
        : {
            decision: {
              choice: lastDecision.decision,
              recordedAt: lastDecision.recordedAt,
              actor: lastDecision.actor,
              ...(lastDecision.note === undefined ? {} : { note: lastDecision.note }),
            },
          }),
      ...(lastExecution?.execution === undefined
        ? {}
        : {
            execution: {
              status: lastExecution.execution.status,
              recordedAt: lastExecution.recordedAt,
              ...(lastExecution.execution.reference === undefined
                ? {}
                : { reference: lastExecution.execution.reference }),
            },
          }),
      supersededDecisions: mine.filter(
        (record) => record.kind === "decision" && record.actionDigest !== actionDigest,
      ).length,
    };
    cards.set(entry.id, card);
    return card;
  };

  return manifest.decisions.map(derive);
}
