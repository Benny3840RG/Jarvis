// Owner decision queue (#801): the append-only ledger and the service that
// re-validates every click on the server before recording it.
//
// The service records the owner's decision and later execution reports. It
// never performs the decided work and grants no authority to any other path.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import {
  assertLedgerIntact,
  confirmationPhrase,
  deriveOwnerDecisionCards,
  LEDGER_GENESIS_HASH,
  ownerDecisionRecordHash,
  parseOwnerDecisionManifest,
  type OwnerDecisionCard,
  type OwnerDecisionChoice,
  type OwnerDecisionEntry,
  type OwnerDecisionManifest,
  type OwnerDecisionRecord,
  type OwnerExecutionStatus,
} from "./ownerDecision.js";

/** Append-only storage for decision records. */
export interface OwnerDecisionLedger {
  read(): Promise<OwnerDecisionRecord[]>;
  /** Appends exactly one record after the given tail. Never rewrites history. */
  append(record: OwnerDecisionRecord): Promise<void>;
}

export class InMemoryOwnerDecisionLedger implements OwnerDecisionLedger {
  private readonly records: OwnerDecisionRecord[] = [];

  async read(): Promise<OwnerDecisionRecord[]> {
    return [...this.records];
  }

  async append(record: OwnerDecisionRecord): Promise<void> {
    this.records.push(record);
  }
}

/** One JSON record per line, opened for append only, owner-readable only. */
export class JsonLinesOwnerDecisionLedger implements OwnerDecisionLedger {
  constructor(private readonly filePath: string) {}

  async read(): Promise<OwnerDecisionRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as OwnerDecisionRecord);
  }

  async append(record: OwnerDecisionRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(this.filePath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export type OwnerDecisionRefusalCode =
  | "not-found"
  | "stale"
  | "subject-changed"
  | "expired"
  | "not-ready"
  | "already-decided"
  | "confirmation-required"
  | "idempotency-conflict"
  | "not-approved"
  | "already-executed"
  | "unavailable";

export class OwnerDecisionRefusal extends Error {
  constructor(
    readonly code: OwnerDecisionRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Optional live check of a decision's subject. Returns the commit the subject
 * is at now, or null when it cannot tell. Without a probe the service checks
 * the click against the manifest only.
 */
export type OwnerDecisionSubjectProbe = (
  entry: OwnerDecisionEntry,
) => Promise<{ sha: string } | null>;

export type OwnerDecisionQueue = Readonly<{
  repository: string;
  generatedAt: string;
  /** False when the queue can only be read: no approval token, or the ledger is unreadable. */
  decisionsAvailable: boolean;
  unavailableReason?: string;
  subjectVerification: "manifest-only" | "live-probe";
  cards: readonly OwnerDecisionCard[];
  excluded: OwnerDecisionManifest["excluded"];
}>;

export type DecideRequest = Readonly<{
  decisionId: string;
  expectedDigest: string;
  choice: OwnerDecisionChoice;
  idempotencyKey: string;
  confirmation?: string;
  note?: string;
  actor: string;
}>;

export type ExecutionReport = Readonly<{
  decisionId: string;
  expectedDigest: string;
  status: OwnerExecutionStatus;
  idempotencyKey: string;
  reference?: string;
  actor: string;
}>;

export type RecordedResult = Readonly<{
  card: OwnerDecisionCard;
  recordId: string;
  /** True when this exact request was already recorded and nothing new was written. */
  replayed: boolean;
}>;

export type OwnerDecisionServiceOptions = Readonly<{
  manifest: OwnerDecisionManifest;
  ledger: OwnerDecisionLedger;
  /** Whether the separate approval token is configured right now. */
  approvalConfigured: () => boolean;
  clock?: () => number;
  subjectProbe?: OwnerDecisionSubjectProbe;
}>;

export class OwnerDecisionService {
  private readonly manifest: OwnerDecisionManifest;
  private readonly ledger: OwnerDecisionLedger;
  private readonly approvalConfigured: () => boolean;
  private readonly clock: () => number;
  private readonly subjectProbe: OwnerDecisionSubjectProbe | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: OwnerDecisionServiceOptions) {
    this.manifest = options.manifest;
    this.ledger = options.ledger;
    this.approvalConfigured = options.approvalConfigured;
    this.clock = options.clock ?? Date.now;
    this.subjectProbe = options.subjectProbe;
  }

  /** Every write runs alone, in arrival order, so two clicks cannot interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async intactRecords(): Promise<OwnerDecisionRecord[]> {
    const records = await this.ledger.read();
    assertLedgerIntact(records);
    return records;
  }

  /** Read-only view. Works without any token and when decisions are unavailable. */
  async inspect(): Promise<OwnerDecisionQueue> {
    const nowMs = this.clock();
    let records: OwnerDecisionRecord[] = [];
    let unavailableReason: string | undefined;
    try {
      records = await this.intactRecords();
    } catch {
      unavailableReason =
        "The decision ledger could not be read or failed its integrity check. Recorded decisions are not shown and no new decision can be recorded.";
    }
    if (unavailableReason === undefined && !this.approvalConfigured()) {
      unavailableReason =
        "No approval token is configured on this runtime. The queue is read-only until one is set.";
    }
    return {
      repository: this.manifest.repository,
      generatedAt: new Date(nowMs).toISOString(),
      decisionsAvailable: unavailableReason === undefined,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      subjectVerification: this.subjectProbe === undefined ? "manifest-only" : "live-probe",
      cards: deriveOwnerDecisionCards(this.manifest, records, nowMs),
      excluded: this.manifest.excluded,
    };
  }

  private async loadForWrite(decisionId: string): Promise<{
    records: OwnerDecisionRecord[];
    card: OwnerDecisionCard;
    nowMs: number;
  }> {
    let records: OwnerDecisionRecord[];
    try {
      records = await this.intactRecords();
    } catch {
      throw new OwnerDecisionRefusal(
        "unavailable",
        "The decision ledger is unreadable or not intact. Nothing was recorded.",
      );
    }
    const nowMs = this.clock();
    const card = deriveOwnerDecisionCards(this.manifest, records, nowMs).find(
      (candidate) => candidate.entry.id === decisionId,
    );
    if (card === undefined) {
      throw new OwnerDecisionRefusal("not-found", "No such owner decision.");
    }
    return { records, card, nowMs };
  }

  private replayOf(
    records: readonly OwnerDecisionRecord[],
    idempotencyKey: string,
    requestDigest: string,
  ): OwnerDecisionRecord | undefined {
    const earlier = records.find((record) => record.idempotencyKey === idempotencyKey);
    if (earlier === undefined) return undefined;
    if (earlier.requestDigest !== requestDigest) {
      throw new OwnerDecisionRefusal(
        "idempotency-conflict",
        "This idempotency key was already used for a different request.",
      );
    }
    return earlier;
  }

  private async currentCard(decisionId: string): Promise<OwnerDecisionCard> {
    const records = await this.intactRecords();
    return deriveOwnerDecisionCards(this.manifest, records, this.clock()).find(
      (candidate) => candidate.entry.id === decisionId,
    )!;
  }

  private async appendRecord(
    records: readonly OwnerDecisionRecord[],
    card: OwnerDecisionCard,
    nowMs: number,
    fields: Pick<
      OwnerDecisionRecord,
      "kind" | "decision" | "execution" | "note" | "actor" | "idempotencyKey" | "requestDigest"
    >,
  ): Promise<OwnerDecisionRecord> {
    const unhashed: Omit<OwnerDecisionRecord, "hash"> = {
      sequence: records.length + 1,
      recordId: randomUUID(),
      decisionId: card.entry.id,
      actionDigest: card.actionDigest,
      subjectSha: card.entry.subject.sha,
      environment: card.entry.environment,
      recordedAt: new Date(nowMs).toISOString(),
      previousHash: records.at(-1)?.hash ?? LEDGER_GENESIS_HASH,
      ...fields,
    };
    const record = { ...unhashed, hash: ownerDecisionRecordHash(unhashed) };
    await this.ledger.append(record);
    return record;
  }

  /** Records the owner's decision after re-checking everything on the server. */
  decide(request: DecideRequest): Promise<RecordedResult> {
    return this.exclusive(async () => {
      if (!this.approvalConfigured()) {
        throw new OwnerDecisionRefusal(
          "unavailable",
          "No approval token is configured. Nothing was recorded.",
        );
      }
      const { records, card, nowMs } = await this.loadForWrite(request.decisionId);
      const requestDigest = sha256Hex(
        canonicalJson({
          kind: "decision",
          decisionId: request.decisionId,
          expectedDigest: request.expectedDigest,
          choice: request.choice,
          note: request.note ?? null,
        }),
      );
      const replay = this.replayOf(records, request.idempotencyKey, requestDigest);
      if (replay !== undefined) {
        return { card, recordId: replay.recordId, replayed: true };
      }
      if (request.expectedDigest !== card.actionDigest) {
        throw new OwnerDecisionRefusal(
          "stale",
          "This card changed after it was shown. Reload the queue and read it again.",
        );
      }
      if (this.subjectProbe !== undefined) {
        const live = await this.subjectProbe(card.entry);
        if (live === null) {
          throw new OwnerDecisionRefusal(
            "unavailable",
            "The current state of the subject could not be confirmed. Nothing was recorded.",
          );
        }
        if (live.sha !== card.entry.subject.sha) {
          throw new OwnerDecisionRefusal(
            "subject-changed",
            `${card.entry.subject.ref} has moved to a different commit since this card was written.`,
          );
        }
      }
      const { status } = card;
      if (request.choice === "approve") {
        if (status === "EXPIRED") {
          throw new OwnerDecisionRefusal("expired", "This request has expired.");
        }
        if (status === "NOT_READY") {
          throw new OwnerDecisionRefusal(
            "not-ready",
            `Not ready to approve: ${card.blockedBy.join(" ")}`,
          );
        }
        if (status !== "READY") {
          throw new OwnerDecisionRefusal(
            "already-decided",
            `This card is already ${status}. Nothing was recorded.`,
          );
        }
        if (card.entry.risk === "high" && request.confirmation !== confirmationPhrase(card.entry)) {
          throw new OwnerDecisionRefusal(
            "confirmation-required",
            `Type "${confirmationPhrase(card.entry)}" to approve this high-risk decision.`,
          );
        }
      } else if (status !== "READY" && status !== "NOT_READY" && status !== "APPROVED") {
        // Reject and request-changes may also withdraw an approval that has not
        // been executed. Anything else is already settled for this card.
        throw new OwnerDecisionRefusal(
          "already-decided",
          `This card is already ${status}. Nothing was recorded.`,
        );
      }
      const record = await this.appendRecord(records, card, nowMs, {
        kind: "decision",
        decision: request.choice,
        ...(request.note === undefined ? {} : { note: request.note }),
        actor: request.actor,
        idempotencyKey: request.idempotencyKey,
        requestDigest,
      });
      return {
        card: await this.currentCard(request.decisionId),
        recordId: record.recordId,
        replayed: false,
      };
    });
  }

  /**
   * Records what happened when approved work was carried out elsewhere. An
   * indeterminate result may later be resolved; executed and failed are final
   * for this approval.
   */
  reportExecution(report: ExecutionReport): Promise<RecordedResult> {
    return this.exclusive(async () => {
      const { records, card, nowMs } = await this.loadForWrite(report.decisionId);
      const requestDigest = sha256Hex(
        canonicalJson({
          kind: "execution",
          decisionId: report.decisionId,
          expectedDigest: report.expectedDigest,
          status: report.status,
          reference: report.reference ?? null,
        }),
      );
      const replay = this.replayOf(records, report.idempotencyKey, requestDigest);
      if (replay !== undefined) {
        return { card, recordId: replay.recordId, replayed: true };
      }
      if (report.expectedDigest !== card.actionDigest) {
        throw new OwnerDecisionRefusal("stale", "This card changed since it was approved.");
      }
      if (card.status === "EXECUTED" || card.execution?.status === "failed") {
        throw new OwnerDecisionRefusal(
          "already-executed",
          "An execution result is already final for this approval.",
        );
      }
      if (card.status !== "APPROVED") {
        throw new OwnerDecisionRefusal(
          "not-approved",
          `Execution can only be reported for an approved decision; this card is ${card.status}.`,
        );
      }
      const record = await this.appendRecord(records, card, nowMs, {
        kind: "execution",
        execution: {
          status: report.status,
          ...(report.reference === undefined ? {} : { reference: report.reference }),
        },
        actor: report.actor,
        idempotencyKey: report.idempotencyKey,
        requestDigest,
      });
      return {
        card: await this.currentCard(report.decisionId),
        recordId: record.recordId,
        replayed: false,
      };
    });
  }
}

/** Loads and validates the reviewed manifest shipped with the source. */
export function loadOwnerDecisionManifest(): OwnerDecisionManifest {
  return parseOwnerDecisionManifest(
    JSON.parse(
      readFileSync(new URL("./ownerDecisionManifest.json", import.meta.url), "utf8"),
    ) as unknown,
  );
}
