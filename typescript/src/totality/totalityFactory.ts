import {
  GeminiTotalityReasoner,
  resolveGeminiTotalityConfig,
  resolveGeminiTotalityModel,
} from "../integrations/gemini/totalityReasoner.js";
import {
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
  resolveOpenAITotalityModel,
} from "../integrations/openai/totalityReasoner.js";
import { ConvexTotalityJournal } from "../persistence/convexTotalityJournal.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { TotalityPipeline } from "./totalityPipeline.js";

export type TotalityReasonerProviderName = "openai" | "gemini";

/**
 * Read-only description of the Totality reasoning integration for status
 * surfaces (HTTP `/api/v1/status`, the MCP `get_jarvis_status` tool, and the
 * operator HUD). Never makes a live call to either provider -- "configured"
 * means the required API key env var is present and a pipeline *would* be
 * constructed by `createTotalityPipelineFromEnv`, not that the provider has
 * ever been successfully reached. There is deliberately no "verified" state:
 * this repo does not fire speculative probe calls just to populate a status
 * page (matching CostProvenance's "no live call, no VERIFIED_PROVIDER claim"
 * discipline in modelResourceGovernance.ts).
 */
export type TotalityReasoningStatus = {
  status: "not-configured" | "configured";
  provider: TotalityReasonerProviderName | null;
  model: string | null;
  reason: string;
};

const UNVERIFIED_REASON =
  "Configuration only -- invocation has not been verified with a live provider call.";

export function resolveTotalityReasoningStatus(): TotalityReasoningStatus {
  if (resolvePersistenceProviderName() !== "convex") {
    return {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "Totality reasoning requires Convex persistence, which is not the active provider.",
    };
  }

  const provider = resolveTotalityReasonerProviderName();
  if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) {
      return {
        status: "not-configured",
        provider,
        model: null,
        reason: "GEMINI_API_KEY is not set.",
      };
    }
    return {
      status: "configured",
      provider,
      model: resolveGeminiTotalityModel(process.env.GEMINI_MODEL),
      reason: UNVERIFIED_REASON,
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      status: "not-configured",
      provider,
      model: null,
      reason: "OPENAI_API_KEY is not set.",
    };
  }
  return {
    status: "configured",
    provider,
    model: resolveOpenAITotalityModel(process.env.OPENAI_MODEL),
    reason: UNVERIFIED_REASON,
  };
}

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
