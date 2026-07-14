import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { TotalityJournal } from "../totality/totalityPipeline.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const reasoningJournalFunctions = api.reasoningJournal;

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

  async commitOutcome(input: Parameters<TotalityJournal["commitOutcome"]>[0]): Promise<void> {
    await this.client.mutation(reasoningJournalFunctions.commit, {
      serviceToken: this.serviceToken,
      requestId: input.requestId,
      ...(input.projectId === null ? {} : { projectKey: input.projectId }),
      report: input.report,
      event: {
        eventType: input.eventType,
        actor: input.actor,
        payload: input.payload,
      },
    });
  }
}
