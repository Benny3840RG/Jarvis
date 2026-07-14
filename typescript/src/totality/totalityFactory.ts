import {
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../integrations/openai/totalityReasoner.js";
import { ConvexTotalityJournal } from "../persistence/convexTotalityJournal.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { TotalityPipeline } from "./totalityPipeline.js";

export function createTotalityPipelineFromEnv(): TotalityPipeline | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (resolvePersistenceProviderName() !== "convex") {
    throw new Error(
      "OPENAI_API_KEY enables Totality reasoning only when PERSISTENCE_PROVIDER=convex.",
    );
  }

  return new TotalityPipeline(
    new OpenAITotalityReasoner(resolveOpenAITotalityConfig()),
    new ConvexTotalityJournal(),
  );
}
