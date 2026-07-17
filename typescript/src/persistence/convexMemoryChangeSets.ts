import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  AppliedMemoryRecord,
  ApplyMemoryChangeSetResult,
  MemoryChangeSet,
  MemoryChangeSetService,
  MemoryRecord,
} from "../memory/memoryChangeSets.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const memoryChangeSetFunctions = api.memoryChangeSets;

type ChangeSetRow = {
  changeSetId: string;
  requestId: string;
  projectKey: string;
  baseRevision: number;
  state: MemoryChangeSet["state"];
  records: MemoryRecord[];
  rationale: string;
  proposedBy: MemoryChangeSet["proposedBy"];
  approvedBy?: "user";
  rejectedBy?: "user";
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  appliedAt?: number;
  appliedRevision?: number;
};

type ProjectRecordRow = {
  recordId: string;
  projectKey: string;
  kind: MemoryRecord["kind"];
  record: MemoryRecord;
  updatedAt: number;
};

function timestamp(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function changeSetFromConvex(row: ChangeSetRow): MemoryChangeSet {
  return {
    changeSetId: row.changeSetId,
    requestId: row.requestId,
    projectId: row.projectKey,
    baseRevision: row.baseRevision,
    state: row.state,
    records: row.records,
    rationale: row.rationale,
    proposedBy: row.proposedBy,
    ...(row.approvedBy === undefined ? {} : { approvedBy: row.approvedBy }),
    ...(row.rejectedBy === undefined ? {} : { rejectedBy: row.rejectedBy }),
    ...(row.rejectedReason === undefined ? {} : { rejectedReason: row.rejectedReason }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(timestamp(row.approvedAt) === undefined ? {} : { approvedAt: timestamp(row.approvedAt) }),
    ...(timestamp(row.rejectedAt) === undefined ? {} : { rejectedAt: timestamp(row.rejectedAt) }),
    ...(timestamp(row.appliedAt) === undefined ? {} : { appliedAt: timestamp(row.appliedAt) }),
    ...(row.appliedRevision === undefined ? {} : { appliedRevision: row.appliedRevision }),
  };
}

function projectRecordFromConvex(row: ProjectRecordRow): AppliedMemoryRecord {
  return {
    recordId: row.recordId,
    projectId: row.projectKey,
    kind: row.kind,
    record: row.record,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export class ConvexMemoryChangeSetService implements MemoryChangeSetService {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error("Memory approval requires JARVIS_SERVICE_TOKEN.");
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Memory approval requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async stage(input: Parameters<MemoryChangeSetService["stage"]>[0]): Promise<MemoryChangeSet> {
    const row = await this.client.mutation(memoryChangeSetFunctions.stage, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      requestId: input.requestId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
      records: input.records,
      rationale: input.rationale,
      proposedBy: input.proposedBy,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async get(input: Parameters<MemoryChangeSetService["get"]>[0]): Promise<MemoryChangeSet | null> {
    const row = await this.client.query(memoryChangeSetFunctions.get, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      projectKey: input.projectId,
    });
    return row === null ? null : changeSetFromConvex(row as ChangeSetRow);
  }

  async list(input: Parameters<MemoryChangeSetService["list"]>[0]): Promise<MemoryChangeSet[]> {
    const rows = await this.client.query(memoryChangeSetFunctions.listRecent, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return (rows as ChangeSetRow[]).map(changeSetFromConvex);
  }

  async approve(input: Parameters<MemoryChangeSetService["approve"]>[0]): Promise<MemoryChangeSet> {
    const row = await this.client.mutation(memoryChangeSetFunctions.approve, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async reject(input: Parameters<MemoryChangeSetService["reject"]>[0]): Promise<MemoryChangeSet> {
    const row = await this.client.mutation(memoryChangeSetFunctions.reject, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      reason: input.reason,
    });
    return changeSetFromConvex(row as ChangeSetRow);
  }

  async apply(
    input: Parameters<MemoryChangeSetService["apply"]>[0],
  ): Promise<ApplyMemoryChangeSetResult> {
    const result = await this.client.mutation(memoryChangeSetFunctions.apply, {
      serviceToken: this.serviceToken,
      changeSetId: input.changeSetId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
    });
    const typed = result as {
      changeSet: ChangeSetRow;
      project: { revision: number };
      records: ProjectRecordRow[];
      idempotent: boolean;
    };
    return {
      changeSet: changeSetFromConvex(typed.changeSet),
      projectRevision: typed.project.revision,
      records: typed.records.map(projectRecordFromConvex),
      idempotent: typed.idempotent,
    };
  }
}
