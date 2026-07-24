import {
  GeminiTotalityReasoner,
  resolveGeminiTotalityConfig,
} from "../integrations/gemini/totalityReasoner.js";
import {
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../integrations/openai/totalityReasoner.js";
import { ConvexTotalityJournal } from "../persistence/convexTotalityJournal.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { TotalityPipeline } from "./totalityPipeline.js";

export type TotalityReasonerProviderName = "openai" | "gemini";

export function resolveTotalityReasonerProviderName(
  configured = process.env.TOTALITY_REASONER_PROVIDER,
): TotalityReasonerProviderName {
  const provider = (configured ?? "openai").trim().toLowerCase();
  if (provider === "" || provider === "openai") return "openai";
  if (provider === "gemini") return "gemini";
  throw new Error(
    `Invalid TOTALITY_REASONER_PROVIDER '${configured}'. Valid values: unset, openai, gemini.`,
  );
}

export function createTotalityPipelineFromEnv(): TotalityPipeline | null {
  if (resolvePersistenceProviderName() !== "convex") return null;

  const provider = resolveTotalityReasonerProviderName();
  if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) return null;
    return new TotalityPipeline(
      new GeminiTotalityReasoner(resolveGeminiTotalityConfig()),
      new ConvexTotalityJournal(),
    );
  }

  if (!process.env.OPENAI_API_KEY) return null;
  return new TotalityPipeline(
    new OpenAITotalityReasoner(resolveOpenAITotalityConfig()),
    new ConvexTotalityJournal(),
  );
}
