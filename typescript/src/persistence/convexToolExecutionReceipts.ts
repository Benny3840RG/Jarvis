import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  ToolExecutionReceipt,
  ToolExecutionReceiptStore,
} from "../actions/toolExecution.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const toolExecutionReceiptFunctions = api.toolExecutionReceipts;

type ToolExecutionReceiptRow = {
  receiptKey: string;
  receiptId: string;
  actionId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  tool: string;
  operation: string;
  status: ToolExecutionReceipt["status"];
  outputDigest?: string;
  errorCode?: ToolExecutionReceipt["errorCode"];
  startedAt: number;
  completedAt: number;
};

function receiptFromConvex(row: ToolExecutionReceiptRow): ToolExecutionReceipt {
  return {
    receiptId: row.receiptId,
    actionId: row.actionId,
    projectId: row.projectId,
    idempotencyKey: row.idempotencyKey,
    actionFingerprint: row.actionFingerprint,
    tool: row.tool,
    operation: row.operation,
    status: row.status,
    ...(row.outputDigest === undefined ? {} : { outputDigest: row.outputDigest }),
    ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: new Date(row.completedAt).toISOString(),
  };
}

export class ConvexToolExecutionReceiptStore implements ToolExecutionReceiptStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(
    client?: ConvexClientLike,
    serviceToken = process.env.JARVIS_SERVICE_TOKEN,
  ) {
    if (!serviceToken) throw new Error("Tool execution receipts require JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Tool execution receipts require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async get(key: string): Promise<ToolExecutionReceipt | null> {
    const row = await this.client.query(toolExecutionReceiptFunctions.get, {
      serviceToken: this.serviceToken,
      receiptKey: key,
    });
    return row === null ? null : receiptFromConvex(row as ToolExecutionReceiptRow);
  }

  async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    await this.client.mutation(toolExecutionReceiptFunctions.save, {
      serviceToken: this.serviceToken,
      receiptKey: key,
      receiptId: receipt.receiptId,
      actionId: receipt.actionId,
      projectId: receipt.projectId,
      idempotencyKey: receipt.idempotencyKey,
      actionFingerprint: receipt.actionFingerprint,
      tool: receipt.tool,
      operation: receipt.operation,
      status: receipt.status,
      ...(receipt.outputDigest === undefined ? {} : { outputDigest: receipt.outputDigest }),
      ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
      startedAt: new Date(receipt.startedAt).getTime(),
      completedAt: new Date(receipt.completedAt).getTime(),
    });
  }
}
