import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { TotalityJournal } from "../totality/totalityPipeline.js";
import type { ValidationReport } from "../runtime/validation.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const validationReportFunctions = api.validationReports;
export const auditEventFunctions = api.auditEvents;

export class ConvexTotalityJournal implements TotalityJournal {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error("Totality Convex journalling requires JARVIS_SERVICE_TOKEN.");
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("Totality Convex journalling requires CONVEX_URL.");
    }
    this.client = new ConvexHttpClient(convexUrl);
  }

  async recordValidation(input: {
    requestId: string;
    projectId: string | null;
    report: ValidationReport;
  }): Promise<void> {
    await this.client.mutation(validationReportFunctions.record, {
      serviceToken: this.serviceToken,
      requestId: input.requestId,
      ...(input.projectId === null ? {} : { projectKey: input.projectId }),
      passed: input.report.passed,
      checks: input.report.checks,
      warnings: input.report.warnings,
      blockingFailures: input.report.blockingFailures,
    });
  }

  async appendAudit(input: {
    requestId: string;
    projectId: string | null;
    eventType: string;
    actor: "agent";
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.client.mutation(auditEventFunctions.append, {
      serviceToken: this.serviceToken,
      requestId: input.requestId,
      ...(input.projectId === null ? {} : { projectKey: input.projectId }),
      eventType: input.eventType,
      actor: input.actor,
      payload: input.payload,
    });
  }
}
