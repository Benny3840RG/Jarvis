import {
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../integrations/openai/totalityReasoner.js";
import { ConvexMemoryChangeSetService } from "../persistence/convexMemoryChangeSets.js";
import { ConvexTotalityJournal } from "../persistence/convexTotalityJournal.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { TotalityPipeline } from "./totalityPipeline.js";

export function createTotalityPipelineFromEnv(): TotalityPipeline | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (resolvePersistenceProviderName() !== "convex") return null;

  return new TotalityPipeline(
    new OpenAITotalityReasoner(resolveOpenAITotalityConfig()),
    new ConvexTotalityJournal(),
    new ConvexMemoryChangeSetService(),
  );
}
