import {
  GeminiTotalityReasoner,
  resolveGeminiTotalityConfig,
} from "../integrations/gemini/totalityReasoner.js";
import {
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../integrations/openai/totalityReasoner.js";
import { ConvexTotalityJournal } from "../persistence/convexTotalityJournal.js";
import {
  resolvePersistenceProviderName,
  type PersistenceProviderName,
} from "../persistence/providerSelection.js";
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

/**
 * Accepts the already-resolved persistence provider name rather than
 * re-reading PERSISTENCE_PROVIDER itself, so this can never disagree with
 * the `provider` field callers (e.g. SystemStatusService) report alongside
 * it from the same resolved value.
 *
 * Resolves the reasoner's full config via the same
 * `resolveOpenAITotalityConfig`/`resolveGeminiTotalityConfig` functions
 * `createTotalityPipelineFromEnv` uses -- never a hand-rolled subset of
 * their validation -- so "configured" here and "a pipeline is actually
 * constructed" there cannot drift apart. The resolved API key is discarded;
 * only `model` is ever reported.
 */
export function resolveTotalityReasoningStatus(
  providerName: PersistenceProviderName = resolvePersistenceProviderName(),
): TotalityReasoningStatus {
  if (providerName !== "convex") {
    return {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "Totality reasoning requires Convex persistence, which is not the active provider.",
    };
  }

  let provider: TotalityReasonerProviderName;
  try {
    provider = resolveTotalityReasonerProviderName();
  } catch {
    return {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "TOTALITY_REASONER_PROVIDER is invalid.",
    };
  }

  try {
    const model =
      provider === "gemini"
        ? resolveGeminiTotalityConfig().model
        : resolveOpenAITotalityConfig().model;
    return { status: "configured", provider, model, reason: UNVERIFIED_REASON };
  } catch (error) {
    return {
      status: "not-configured",
      provider,
      model: null,
      reason: error instanceof Error ? error.message : "Reasoning configuration is invalid.",
    };
  }
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
