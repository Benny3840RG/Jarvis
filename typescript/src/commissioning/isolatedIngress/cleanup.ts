import { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";

export type CommissioningCleanupResult = {
  campaignId: string;
  deleted: Array<{ runId: string; steps: number; reconciliations: number }>;
  notFound: string[];
};

export type CommissioningCleanupDeps = {
  serviceToken?: string;
  client?: ConvexClientLike;
};

/**
 * Deletes the durable records a commissioning campaign created, by recorded run
 * id. The Convex mutation verifies owner + campaign membership per run and
 * aborts the whole transaction if any run is not a member, so a wrong id list
 * cannot delete anything.
 */
export async function purgeCommissioningRuns(
  deps: CommissioningCleanupDeps,
  input: { campaignId: string; runIds: readonly string[] },
): Promise<CommissioningCleanupResult> {
  const serviceToken = deps.serviceToken ?? process.env.JARVIS_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new Error("Commissioning cleanup requires JARVIS_SERVICE_TOKEN.");
  }
  let client = deps.client;
  if (!client) {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Commissioning cleanup requires CONVEX_URL.");
    client = new ConvexHttpClient(convexUrl);
  }

  const result = (await client.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
    serviceToken,
    campaignId: input.campaignId,
    runIds: [...input.runIds],
  })) as CommissioningCleanupResult;
  return result;
}
