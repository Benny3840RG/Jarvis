export type MemoryChangeSetState = "proposed" | "approved" | "rejected" | "applied";
export type MemoryChangeSetActor = "user" | "agent" | "tool";

export type MemoryFact = {
  kind: "fact";
  recordId: string;
  statement: string;
  source: "user" | "file" | "tool" | "measurement" | "inference";
  confidence: number;
  recordedAt: string;
};

export type MemoryAssumption = {
  kind: "assumption";
  recordId: string;
  statement: string;
  status: "unverified" | "verified" | "rejected";
  impact: "low" | "medium" | "high";
};

export type MemoryMeasurement = {
  kind: "measurement";
  recordId: string;
  name: string;
  value: number;
  unit: string;
  tolerance?: string;
  source: string;
};

export type MemoryDecision = {
  kind: "decision";
  recordId: string;
  decision: string;
  rationale: string;
  alternativesRejected: string[];
  timestamp: string;
};

export type MemoryRecord = MemoryFact | MemoryAssumption | MemoryMeasurement | MemoryDecision;

export type MemoryChangeSet = {
  changeSetId: string;
  requestId: string;
  projectId: string;
  baseRevision: number;
  state: MemoryChangeSetState;
  records: MemoryRecord[];
  rationale: string;
  proposedBy: MemoryChangeSetActor;
  approvedBy?: "user";
  rejectedBy?: "user";
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  appliedAt?: string;
  appliedRevision?: number;
};

export type AppliedMemoryRecord = {
  recordId: string;
  projectId: string;
  kind: MemoryRecord["kind"];
  record: MemoryRecord;
  updatedAt: string;
};

export type ApplyMemoryChangeSetResult = {
  changeSet: MemoryChangeSet;
  projectRevision: number;
  records: AppliedMemoryRecord[];
  idempotent: boolean;
};

export interface MemoryChangeSetService {
  stage(input: {
    changeSetId: string;
    requestId: string;
    projectId: string;
    expectedRevision: number;
    records: MemoryRecord[];
    rationale: string;
    proposedBy: MemoryChangeSetActor;
  }): Promise<MemoryChangeSet>;
  get(input: { changeSetId: string; projectId: string }): Promise<MemoryChangeSet | null>;
  list(input: {
    projectId: string;
    state?: MemoryChangeSetState;
    limit?: number;
  }): Promise<MemoryChangeSet[]>;
  approve(input: {
    changeSetId: string;
    projectId: string;
    expectedRevision: number;
  }): Promise<MemoryChangeSet>;
  reject(input: {
    changeSetId: string;
    projectId: string;
    reason: string;
  }): Promise<MemoryChangeSet>;
  apply(input: {
    changeSetId: string;
    projectId: string;
    expectedRevision: number;
  }): Promise<ApplyMemoryChangeSetResult>;
}
