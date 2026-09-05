import { resolveTrustedModelProfile } from "../development/modelResourceGovernance.js";
import type { ReasoningConfigurationStatus } from "../http/contracts.js";
import { resolveGeminiTotalityConfig } from "../integrations/gemini/totalityReasoner.js";
import { resolveOpenAITotalityConfig } from "../integrations/openai/totalityReasoner.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import { resolveTotalityReasonerProviderName } from "./totalityFactory.js";

/**
 * Derives the bounded, non-secret reasoning configuration projection from
 * the same trusted runtime configuration `createTotalityPipelineFromEnv`
 * uses to build the real Totality pipeline — no parallel truth store.
 *
 * This never proves a model call has succeeded or will succeed; it only
 * reports what the deployment is configured to use. An unsupported or
 * untrusted provider/model combination is reported as `not-configured`
 * rather than surfaced on the public contract (handover: do not trust an
 * unverified identity claim when a trusted registry exists).
 */
export function resolveReasoningConfigurationStatus(
  providerName: PersistenceProviderName,
  env: NodeJS.ProcessEnv = process.env,
): ReasoningConfigurationStatus {
  if (providerName !== "convex") {
    return {
      status: "not-configured",
      reason: "Totality reasoning requires Convex persistence, which is not the active provider.",
    };
  }

  let reasonerProvider: "openai" | "gemini";
  try {
    reasonerProvider = resolveTotalityReasonerProviderName(env.TOTALITY_REASONER_PROVIDER);
  } catch {
    return {
      status: "not-configured",
      reason: "TOTALITY_REASONER_PROVIDER is not a recognised reasoning provider.",
    };
  }

  let model: string;
  try {
    if (reasonerProvider === "gemini") {
      if (!env.GEMINI_API_KEY) {
        return {
          status: "not-configured",
          reason: "Gemini reasoning credentials are not configured.",
        };
      }
      model = resolveGeminiTotalityConfig(env).model;
    } else {
      if (!env.OPENAI_API_KEY) {
        return {
          status: "not-configured",
          reason: "OpenAI reasoning credentials are not configured.",
        };
      }
      model = resolveOpenAITotalityConfig(env).model;
    }
  } catch {
    return {
      status: "not-configured",
      reason: "The configured reasoning model identifier is invalid.",
    };
  }

  const profile = resolveTrustedModelProfile({ provider: reasonerProvider, model });
  if (!profile) {
    return {
      status: "not-configured",
      reason: "The configured reasoning model is not part of the trusted model registry.",
    };
  }

  return {
    status: "configured",
    provider: profile.provider,
    model: profile.model,
    observability: "configuration-only",
  };
}
