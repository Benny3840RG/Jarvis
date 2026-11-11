// Owner decision queue (#801): the append-only ledger and the service that
// re-validates every click on the server before recording it.
//
// The service records the owner's decision and later execution reports. It
// never performs the decided work and grants no authority to any other path.

import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
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
  pinsOf,
  subjectLabel,
  type OwnerDecisionCard,
  type OwnerDecisionChoice,
  type OwnerDecisionManifest,
  type OwnerDecisionRecord,
  type OwnerDecisionSubject,
  type OwnerExecutionStatus,
} from "./ownerDecision.js";

export type OwnerDecisionLedgerState = "ready" | "not-started" | "damaged";

/** Thrown by a ledger that has not been started or cannot be trusted. */
export class OwnerDecisionLedgerError extends Error {
  constructor(
    readonly state: Exclude<OwnerDecisionLedgerState, "ready">,
    message: string,
  ) {
    super(message);
  }
}

/** Append-only storage for decision records. */
export interface OwnerDecisionLedger {
  /** Throws OwnerDecisionLedgerError when the ledger is not started or is damaged. */
  read(): Promise<OwnerDecisionRecord[]>;
  /** Appends exactly one record. Never rewrites history. */
  append(record: OwnerDecisionRecord): Promise<void>;
  /** Starts a new, empty ledger. Refuses when anything is already there. */
  start(): Promise<void>;
}

export class InMemoryOwnerDecisionLedger implements OwnerDecisionLedger {
  private readonly records: OwnerDecisionRecord[] = [];
  private started: boolean;

  constructor(options: { started?: boolean } = {}) {
    this.started = options.started ?? true;
  }

  async read(): Promise<OwnerDecisionRecord[]> {
    if (!this.started) {
      throw new OwnerDecisionLedgerError(
        "not-started",
        "The decision ledger has not been started.",
      );
    }
    return [...this.records];
  }

  async append(record: OwnerDecisionRecord): Promise<void> {
    await this.read();
    this.records.push(record);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("The decision ledger already exists.");
    this.started = true;
  }
}

type LedgerCheckpoint = { count: number; hash: string };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function damaged(message: string): OwnerDecisionLedgerError {
  return new OwnerDecisionLedgerError("damaged", message);
}

/**
 * One JSON record per line in an append-only file, plus a checkpoint file
 * holding the count and hash of the last record. The checkpoint is what makes
 * a shortened or deleted ledger detectable: the hash chain alone only proves
 * that what remains is consistent.
 *
 * A data directory with neither file has no ledger. That is never treated as
 * an empty ledger, because a directory restored from a backup looks the same;
 * the owner must restore the two files or start a new ledger on purpose.
 */
export class JsonLinesOwnerDecisionLedger implements OwnerDecisionLedger {
  private readonly checkpointPath: string;

  constructor(private readonly filePath: string) {
    this.checkpointPath = `${filePath}.checkpoint.json`;
  }

  /** Opens an existing owner-only regular file without following a symlink. */
  private async openPrivate(filePath: string, flags: number): Promise<fs.FileHandle> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(filePath, flags | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (isMissing(error)) throw error;
      throw damaged("A decision ledger file could not be opened safely.");
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw damaged("A decision ledger file is not an owner-only regular file (mode 0600).");
      }
      return handle;
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }

  private async readPrivate(filePath: string): Promise<string | null> {
    let handle: fs.FileHandle;
    try {
      handle = await this.openPrivate(filePath, constants.O_RDONLY);
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  private async readCheckpoint(): Promise<LedgerCheckpoint | null> {
    const raw = await this.readPrivate(this.checkpointPath);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw damaged("The decision ledger checkpoint is unreadable.");
    }
    const checkpoint = value as Partial<LedgerCheckpoint> | null;
    if (
      typeof checkpoint !== "object" ||
      checkpoint === null ||
      typeof checkpoint.count !== "number" ||
      !Number.isInteger(checkpoint.count) ||
      checkpoint.count < 0 ||
      typeof checkpoint.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(checkpoint.hash)
    ) {
      throw damaged("The decision ledger checkpoint is unreadable.");
    }
    return { count: checkpoint.count, hash: checkpoint.hash };
  }

  async read(): Promise<OwnerDecisionRecord[]> {
    const [raw, checkpoint] = await Promise.all([
      this.readPrivate(this.filePath),
      this.readCheckpoint(),
    ]);
    // An empty ledger file with no checkpoint is a start that was interrupted
    // after creating the file. Nothing was ever recorded; start() resumes it.
    if ((raw === null || raw === "") && checkpoint === null) {
      throw new OwnerDecisionLedgerError(
        "not-started",
        "No decision ledger exists in this data directory.",
      );
    }
    if (raw === null || checkpoint === null) {
      throw damaged("The decision ledger and its checkpoint are not both present.");
    }
    // A crash can leave a partial last line. Appending after it would fuse two
    // records, so an unterminated file is refused rather than repaired.
    if (raw.length > 0 && !raw.endsWith("\n")) {
      throw damaged("The decision ledger ends in an incomplete record.");
    }
    let records: OwnerDecisionRecord[];
    try {
      records = raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as OwnerDecisionRecord);
    } catch {
      throw damaged("The decision ledger contains an unreadable record.");
    }
    // The file may be one record ahead of the checkpoint if the process died
    // between the append and the checkpoint write. It may never be behind.
    const anchored =
      checkpoint.count === 0
        ? checkpoint.hash === LEDGER_GENESIS_HASH
        : records[checkpoint.count - 1]?.hash === checkpoint.hash;
    if (!anchored || records.length > checkpoint.count + 1) {
      throw damaged("The decision ledger does not match its checkpoint; records are missing.");
    }
    return records;
  }

  private async writeCheckpoint(checkpoint: LedgerCheckpoint): Promise<void> {
    const temporary = `${this.checkpointPath}.${process.pid}.tmp`;
    await fs.rm(temporary, { force: true });
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.checkpointPath);
  }

  async append(record: OwnerDecisionRecord): Promise<void> {
    // If an earlier append died before its checkpoint was written, the file is
    // one valid record ahead. Bring the checkpoint level first; otherwise a
    // second interruption would leave it two behind, which read() refuses.
    const existing = await this.read();
    const last = existing.at(-1);
    await this.writeCheckpoint(
      last === undefined
        ? { count: 0, hash: LEDGER_GENESIS_HASH }
        : { count: existing.length, hash: last.hash },
    );
    const handle = await this.openPrivate(this.filePath, constants.O_WRONLY | constants.O_APPEND);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.writeCheckpoint({ count: record.sequence, hash: record.hash });
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if ((await fs.lstat(this.checkpointPath).catch(() => null)) !== null) {
      throw new Error("A decision ledger checkpoint already exists; it is never replaced.");
    }
    // Resume a start that created the empty file and died before the checkpoint.
    const leftover = await this.readPrivate(this.filePath);
    if (leftover !== null && leftover !== "") {
      throw new Error("A decision ledger already exists; it is never replaced.");
    }
    if (leftover === null) {
      const handle = await fs.open(
        this.filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.writeCheckpoint({ count: 0, hash: LEDGER_GENESIS_HASH });
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
  | "execution-unresolved"
  | "ledger-exists"
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
 * Live check of one subject. Returns the revision the subject is at now (a
 * commit for a pull request or branch, the last-updated time for an issue), or
 * null when it cannot tell. An approval is refused unless every subject of the
 * card is confirmed unchanged, so no probe means no approvals.
 */
export type OwnerDecisionSubjectProbe = (subject: OwnerDecisionSubject) => Promise<string | null>;

export type OwnerDecisionQueue = Readonly<{
  repository: string;
  generatedAt: string;
  /** False when nothing can be recorded. The queue can still be read. */
  decisionsAvailable: boolean;
  unavailableReason?: string;
  ledgerState: OwnerDecisionLedgerState;
  /** "none" means approvals are refused: nothing can confirm the subjects are unchanged. */
  subjectVerification: "none" | "live-probe";
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

type WriteState = {
  ledgerState: OwnerDecisionLedgerState;
  records: OwnerDecisionRecord[];
  /** Why nothing can be written right now; undefined when writes are allowed. */
  reason?: string;
};

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

  /** The one read-only rule, used by the view and by every write. */
  private async writeState(): Promise<WriteState> {
    let records: OwnerDecisionRecord[];
    try {
      records = await this.ledger.read();
      assertLedgerIntact(records);
    } catch (error: unknown) {
      if (error instanceof OwnerDecisionLedgerError && error.state === "not-started") {
        return {
          ledgerState: "not-started",
          records: [],
          reason:
            "No decision ledger exists on this runtime. If this runtime was restored from a backup, restore the ledger and its checkpoint first; otherwise start a new ledger. Until then nothing can be recorded and no earlier decision is shown.",
        };
      }
      return {
        ledgerState: "damaged",
        records: [],
        reason:
          "The decision ledger could not be read or failed its integrity check. Recorded decisions are not shown and nothing can be recorded.",
      };
    }
    return {
      ledgerState: "ready",
      records,
      ...(this.approvalConfigured()
        ? {}
        : {
            reason:
              "No approval token is configured on this runtime. The queue is read-only until one is set.",
          }),
    };
  }

  /** Read-only view. Works without any token and when nothing can be recorded. */
  async inspect(): Promise<OwnerDecisionQueue> {
    const nowMs = this.clock();
    const { ledgerState, records, reason } = await this.writeState();
    return {
      repository: this.manifest.repository,
      generatedAt: new Date(nowMs).toISOString(),
      decisionsAvailable: reason === undefined,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
      ledgerState,
      subjectVerification: this.subjectProbe === undefined ? "none" : "live-probe",
      cards: deriveOwnerDecisionCards(this.manifest, records, nowMs),
      excluded: this.manifest.excluded,
    };
  }

  /**
   * Starts a new, empty ledger on a runtime that has none. Deliberate, so a
   * restored data directory is never mistaken for one with no decisions.
   */
  startLedger(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.approvalConfigured()) {
        throw new OwnerDecisionRefusal("unavailable", "No approval token is configured.");
      }
      const { ledgerState } = await this.writeState();
      if (ledgerState !== "not-started") {
        throw new OwnerDecisionRefusal(
          "ledger-exists",
          "A decision ledger already exists on this runtime. It is never replaced.",
        );
      }
      await this.ledger.start();
    });
  }

  private async loadForWrite(decisionId: string): Promise<{
    records: OwnerDecisionRecord[];
    card: OwnerDecisionCard;
    nowMs: number;
  }> {
    const { records, reason } = await this.writeState();
    if (reason !== undefined) {
      throw new OwnerDecisionRefusal("unavailable", `${reason} Nothing was recorded.`);
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

  /** Appends one record and returns the card as it now stands. */
  private async appendRecord(
    records: readonly OwnerDecisionRecord[],
    card: OwnerDecisionCard,
    nowMs: number,
    fields: Pick<
      OwnerDecisionRecord,
      "kind" | "decision" | "execution" | "note" | "actor" | "idempotencyKey" | "requestDigest"
    >,
  ): Promise<RecordedResult> {
    const unhashed: Omit<OwnerDecisionRecord, "hash"> = {
      sequence: records.length + 1,
      recordId: randomUUID(),
      decisionId: card.entry.id,
      actionDigest: card.actionDigest,
      subjects: card.entry.subjects,
      environment: card.entry.environment,
      recordedAt: new Date(nowMs).toISOString(),
      previousHash: records.at(-1)?.hash ?? LEDGER_GENESIS_HASH,
      ...fields,
    };
    const record = { ...unhashed, hash: ownerDecisionRecordHash(unhashed) };
    await this.ledger.append(record);
    const updated = deriveOwnerDecisionCards(this.manifest, [...records, record], nowMs).find(
      (candidate) => candidate.entry.id === card.entry.id,
    )!;
    return { card: updated, recordId: record.recordId, replayed: false };
  }

  /** Every subject and every piece of proof must be exactly as the card pinned it. */
  private async assertSubjectsUnchanged(card: OwnerDecisionCard): Promise<void> {
    for (const subject of pinsOf(card.entry)) {
      const live = this.subjectProbe === undefined ? null : await this.subjectProbe(subject);
      if (live === null) {
        throw new OwnerDecisionRefusal(
          "unavailable",
          `The current state of ${subjectLabel(subject)} could not be confirmed, so this cannot be approved now. Nothing was recorded.`,
        );
      }
      if (live !== subject.revision) {
        throw new OwnerDecisionRefusal(
          "subject-changed",
          `${subjectLabel(subject)} has changed since this card was written. The card must be reviewed and updated before it can be approved.`,
        );
      }
    }
  }

  /** Records the owner's decision after re-checking everything on the server. */
  decide(request: DecideRequest): Promise<RecordedResult> {
    return this.exclusive(async () => {
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
        // Last, because it leaves the process. Unknown counts as changed.
        await this.assertSubjectsUnchanged(card);
      } else if (status === "APPROVED" && card.execution?.status === "indeterminate") {
        // The effect may have happened. Withdrawing now would bury that; the
        // outcome has to be reported as executed or failed first.
        throw new OwnerDecisionRefusal(
          "execution-unresolved",
          "An execution of this approval is still unresolved. Report its outcome before withdrawing the approval.",
        );
      } else if (status !== "READY" && status !== "NOT_READY" && status !== "APPROVED") {
        // Reject and request-changes may also withdraw an approval that has not
        // been executed. Anything else is already settled for this card.
        throw new OwnerDecisionRefusal(
          "already-decided",
          `This card is already ${status}. Nothing was recorded.`,
        );
      }
      return this.appendRecord(records, card, nowMs, {
        kind: "decision",
        decision: request.choice,
        ...(request.note === undefined ? {} : { note: request.note }),
        actor: request.actor,
        idempotencyKey: request.idempotencyKey,
        requestDigest,
      });
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
      if (
        card.status === "EXECUTED" ||
        (card.status === "APPROVED" && card.execution?.status === "failed")
      ) {
        throw new OwnerDecisionRefusal(
          "already-executed",
          "An execution result is already final for this approval.",
        );
      }
      // An unresolved execution can always be resolved, even after the request
      // expired: the work may have run while the approval was still valid.
      const resolvesUnknown =
        card.status === "EXPIRED" &&
        card.decision?.choice === "approve" &&
        card.execution?.status === "indeterminate";
      if (card.status !== "APPROVED" && !resolvesUnknown) {
        throw new OwnerDecisionRefusal(
          "not-approved",
          `Execution can only be reported for an approved decision; this card is ${card.status}.`,
        );
      }
      return this.appendRecord(records, card, nowMs, {
        kind: "execution",
        execution: {
          status: report.status,
          ...(report.reference === undefined ? {} : { reference: report.reference }),
        },
        actor: report.actor,
        idempotencyKey: report.idempotencyKey,
        requestDigest,
      });
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
