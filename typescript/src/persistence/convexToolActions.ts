import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ToolAction, ToolActionService } from "../actions/toolActions.js";
import type {
  ExecutionEligibilityResult,
  ExecutionEligibilityStore,
  SingleUseConsumptionClaimStore,
  SingleUseExecutionClaimResult,
} from "../actions/toolExecution.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import type { SafetyBinding } from "../safety/safetyBinder.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const toolActionFunctions = api.toolActions;

type ToolActionRow = {
  actionId: string;
  requestId: string;
  projectKey: string;
  baseRevision: number;
  state: ToolAction["state"];
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  rationale: string;
  requiredAuthority: ToolAuthority;
  destructive: boolean;
  idempotencyKey: string;
  proposedBy: ToolAction["proposedBy"];
  approvedBy?: "user";
  rejectedBy?: "user";
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  approvalExpiryPolicy?: ToolAction["approvalExpiryPolicy"];
  approvalExpiresAt?: number;
  expiredObservedAt?: number;
  consumptionPolicy?: ToolAction["consumptionPolicy"];
  revokedBy?: "user";
  revokedReason?: string;
  revokedAt?: number;
  isApprovalExpired?: boolean;
  safetyBinding?: SafetyBinding;
};

function optionalTimestamp(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function actionFromConvex(row: ToolActionRow): ToolAction {
  const approvedAt = optionalTimestamp(row.approvedAt);
  const rejectedAt = optionalTimestamp(row.rejectedAt);
  const approvalExpiresAt = optionalTimestamp(row.approvalExpiresAt);
  const expiredObservedAt = optionalTimestamp(row.expiredObservedAt);
  const revokedAt = optionalTimestamp(row.revokedAt);
  return {
    actionId: row.actionId,
    requestId: row.requestId,
    projectId: row.projectKey,
    baseRevision: row.baseRevision,
    state: row.state,
    tool: row.tool,
    operation: row.operation,
    arguments: row.arguments,
    rationale: row.rationale,
    requiredAuthority: row.requiredAuthority,
    destructive: row.destructive,
    idempotencyKey: row.idempotencyKey,
    proposedBy: row.proposedBy,
    ...(row.approvedBy === undefined ? {} : { approvedBy: row.approvedBy }),
    ...(row.rejectedBy === undefined ? {} : { rejectedBy: row.rejectedBy }),
    ...(row.rejectedReason === undefined ? {} : { rejectedReason: row.rejectedReason }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(rejectedAt === undefined ? {} : { rejectedAt }),
    ...(row.approvalExpiryPolicy === undefined
      ? {}
      : { approvalExpiryPolicy: row.approvalExpiryPolicy }),
    ...(approvalExpiresAt === undefined ? {} : { approvalExpiresAt }),
    ...(expiredObservedAt === undefined ? {} : { expiredObservedAt }),
    ...(row.consumptionPolicy === undefined ? {} : { consumptionPolicy: row.consumptionPolicy }),
    ...(row.revokedBy === undefined ? {} : { revokedBy: row.revokedBy }),
    ...(row.revokedReason === undefined ? {} : { revokedReason: row.revokedReason }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(row.safetyBinding === undefined ? {} : { safetyBinding: row.safetyBinding }),
    ...(row.isApprovalExpired === undefined ? {} : { isApprovalExpired: row.isApprovalExpired }),
  };
}

export class ConvexToolActionService implements ToolActionService {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Tool action approval requires JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Tool action approval requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const row = await this.client.mutation(toolActionFunctions.stage, {
      serviceToken: this.serviceToken,
      actionId: input.actionId,
      requestId: input.requestId,
      projectKey: input.projectId,
      expectedRevision: input.expectedRevision,
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
    });
    return actionFromConvex(row as ToolActionRow);
  }

  async get(input: Parameters<ToolActionService["get"]>[0]): Promise<ToolAction | null> {
    const row = await this.client.query(toolActionFunctions.get, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      actionId: input.actionId,
    });
    return row === null ? null : actionFromConvex(row as ToolActionRow);
  }

  async list(input: Parameters<ToolActionService["list"]>[0]): Promise<ToolAction[]> {
    const rows = await this.client.query(toolActionFunctions.listRecent, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return (rows as ToolActionRow[]).map(actionFromConvex);
  }

  async approve(input: Parameters<ToolActionService["approve"]>[0]): Promise<ToolAction> {
    const row = await this.client.mutation(toolActionFunctions.approve, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      actionId: input.actionId,
      expectedRevision: input.expectedRevision,
    });
    return actionFromConvex(row as ToolActionRow);
  }

  async reject(input: Parameters<ToolActionService["reject"]>[0]): Promise<ToolAction> {
    const row = await this.client.mutation(toolActionFunctions.reject, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      actionId: input.actionId,
      reason: input.reason,
    });
    return actionFromConvex(row as ToolActionRow);
  }

  async revoke(
    input: Parameters<NonNullable<ToolActionService["revoke"]>>[0],
  ): Promise<ToolAction> {
    const row = await this.client.mutation(toolActionFunctions.revoke, {
      serviceToken: this.serviceToken,
      projectKey: input.projectId,
      actionId: input.actionId,
      reason: input.reason,
    });
    return actionFromConvex(row as ToolActionRow);
  }
}

/**
 * Backs `SingleUseConsumptionClaimStore` with the authoritative Convex
 * mutation `claimSingleUseExecution`, whose atomicity comes from Convex's
 * own OCC serializing concurrent mutations against the same document — see
 * that mutation's doc comment for why a read-then-write check in the caller
 * cannot provide the same guarantee.
 */
export class ConvexSingleUseConsumptionClaimStore implements SingleUseConsumptionClaimStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error("Single-use execution claims require JARVIS_SERVICE_TOKEN.");
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Single-use execution claims require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async claim(action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult> {
    return (await this.client.mutation(toolActionFunctions.claimSingleUseExecution, {
      serviceToken: this.serviceToken,
      projectKey: action.projectId,
      actionId: action.actionId,
      claimId,
    })) as SingleUseExecutionClaimResult;
  }
}

/**
 * Backs `ExecutionEligibilityStore` with the authoritative Convex mutation
 * `verifyExecutionEligibility` — the reusable-action counterpart to
 * `ConvexSingleUseConsumptionClaimStore` above, re-checking state/expiry
 * against a fresh read instead of the caller's own, potentially stale,
 * separately-fetched snapshot.
 */
export class ConvexExecutionEligibilityStore implements ExecutionEligibilityStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error("Execution eligibility checks require JARVIS_SERVICE_TOKEN.");
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Execution eligibility checks require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async verify(action: ToolAction): Promise<ExecutionEligibilityResult> {
    return (await this.client.mutation(toolActionFunctions.verifyExecutionEligibility, {
      serviceToken: this.serviceToken,
      projectKey: action.projectId,
      actionId: action.actionId,
    })) as ExecutionEligibilityResult;
  }
}
