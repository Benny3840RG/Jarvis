import type { TotalityRequest } from "../../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../../runtime/totalityContracts.js";
import { routeTotalityTask } from "../../runtime/totalityPolicy.js";
import type { TotalityReasoningContext } from "../../totality/totalityPipeline.js";
import {
  DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS,
  resolveTotalityQuotaConfig,
} from "../../totality/totalityQuota.js";
import {
  parseTotalityDraft,
  TOTALITY_SYSTEM_INSTRUCTIONS,
  type TotalityDraft,
} from "../totalityDraftParsing.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6";
const DEFAULT_TIMEOUT_MS = 60_000;

const MEMORY_PROPOSAL_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact"] },
        statement: { type: "string" },
        source: {
          type: "string",
          enum: ["user", "file", "tool", "measurement", "inference"],
        },
        confidence: { type: "number" },
      },
      required: ["kind", "statement", "source", "confidence"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["assumption"] },
        statement: { type: "string" },
        impact: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["kind", "statement", "impact"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["measurement"] },
        name: { type: "string" },
        value: { type: "number" },
        unit: { type: "string" },
        tolerance: { type: ["string", "null"] },
        source: { type: "string" },
      },
      required: ["kind", "name", "value", "unit", "tolerance", "source"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["decision"] },
        decision: { type: "string" },
        rationale: { type: "string" },
        alternativesRejected: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "decision", "rationale", "alternativesRejected"],
      additionalProperties: false,
    },
  ],
} as const;

const TOTALITY_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    controls: { type: "array", items: { type: "string" } },
    unsupportedClaims: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } },
    memoryProposals: { type: "array", items: MEMORY_PROPOSAL_SCHEMA },
    memoryRationale: { type: "string" },
  },
  required: [
    "answer",
    "assumptions",
    "unknowns",
    "risks",
    "controls",
    "unsupportedClaims",
    "contradictions",
    "memoryProposals",
    "memoryRationale",
  ],
  additionalProperties: false,
} as const;

export type OpenAITotalityDraft = TotalityDraft;

export interface OpenAITotalityResult {
  responseId: string | null;
  draft: OpenAITotalityDraft;
  modelUsage?: {
    provider: "openai";
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

export interface OpenAITotalityConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenAIRequestError";
  }
}

type FetchLike = typeof fetch;

type OpenAIResponsePayload = {
  id?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: unknown;
};

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function extractUsage(payload: OpenAIResponsePayload, model: string) {
  if (!isRecord(payload.usage)) return undefined;
  const inputTokens = nonNegativeInteger(payload.usage.input_tokens);
  const outputTokens = nonNegativeInteger(payload.usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = isRecord(payload.usage.input_tokens_details)
    ? payload.usage.input_tokens_details
    : undefined;
  const cachedInputTokens = nonNegativeInteger(details?.cached_tokens);
  return {
    provider: "openai" as const,
    model,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function cleanRequiredSecret(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  if (/\s/.test(value)) throw new Error(`${field} must not contain whitespace.`);
  return value;
}

function cleanModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(model)) {
    throw new Error("OPENAI_MODEL must be a safe model identifier.");
  }
  return model;
}

function cleanClientRequestId(value: string): string {
  if (value.length === 0 || value.length > 512 || !/^[\x21-\x7E]+$/.test(value)) {
    throw new Error("OpenAI client request ID must contain 1 to 512 visible ASCII characters.");
  }
  return value;
}

function resolveTimeout(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw new Error("OPENAI_TIMEOUT_MS must be an integer.");
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("OPENAI_TIMEOUT_MS must be between 1000 and 300000.");
  }
  return timeoutMs;
}

export function resolveOpenAITotalityConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAITotalityConfig {
  return {
    apiKey: cleanRequiredSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    model: cleanModel(env.OPENAI_MODEL),
    timeoutMs: resolveTimeout(env.OPENAI_TIMEOUT_MS),
    maxOutputTokens: resolveTotalityQuotaConfig(env).maxOutputTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOutputText(payload: OpenAIResponsePayload): string {
  if (!Array.isArray(payload.output)) {
    throw new Error("OpenAI response did not contain an output array.");
  }
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  throw new Error("OpenAI response did not contain output_text content.");
}

function parseResponsePayload(text: string): OpenAIResponsePayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return typeof payload.error.message === "string" ? payload.error.message : null;
}

export class OpenAITotalityReasoner {
  constructor(
    private readonly config: OpenAITotalityConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async reason(
    request: TotalityRequest,
    context: TotalityReasoningContext,
  ): Promise<OpenAITotalityResult> {
    const routing = routeTotalityTask({
      taskType: request.taskType,
      outputStyle: request.outputStyle,
      domainContext: request.domainContext,
    });
    assertRequestAuthority(request, routing);
    const clientRequestId = cleanClientRequestId(request.requestId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": clientRequestId,
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions: TOTALITY_SYSTEM_INSTRUCTIONS,
          input: JSON.stringify({
            goal: request.goal,
            domainContext: request.domainContext,
            constraints: request.constraints,
            inputs: request.inputs,
            routing,
            projectContext: context.project,
            proposalTimestamp: context.proposedAt,
          }),
          store: false,
          max_output_tokens:
            context.maxOutputTokens ??
            this.config.maxOutputTokens ??
            DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS,
          text: {
            format: {
              type: "json_schema",
              name: "jarvis_totality_draft",
              description:
                "A proposal-only technical reasoning draft with optional staged project-memory suggestions.",
              strict: true,
              schema: TOTALITY_DRAFT_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      const payload = parseResponsePayload(responseText);
      if (!response.ok) {
        const message =
          safeErrorMessage(payload) ?? `OpenAI request failed with status ${response.status}.`;
        throw new OpenAIRequestError(
          message,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      if (payload === null) {
        throw new Error("OpenAI returned a non-JSON success response.");
      }

      const outputText = extractOutputText(payload);
      const parsed = parseTotalityDraft(JSON.parse(outputText) as unknown);
      return {
        responseId: typeof payload.id === "string" ? payload.id : null,
        draft: parsed,
        ...(extractUsage(payload, this.config.model)
          ? { modelUsage: extractUsage(payload, this.config.model) }
          : {}),
      };
    } catch (error: unknown) {
      if (error instanceof OpenAIRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenAIRequestError("OpenAI request timed out.", null, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        throw new OpenAIRequestError(`OpenAI network request failed: ${message}`, null, true);
      }
      throw new OpenAIRequestError(`OpenAI response processing failed: ${message}`, null, false);
    } finally {
      clearTimeout(timeout);
    }
  }
}
