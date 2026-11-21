import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { readBoundedResponseText } from "../boundedResponse.js";
import { TOTALITY_DRAFT_SCHEMA } from "../openai/totalityReasoner.js";
import type { TotalityRequest } from "../../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../../runtime/totalityContracts.js";
import { routeTotalityTask } from "../../runtime/totalityPolicy.js";
import {
  asCallerDisconnected,
  linkProviderCancellation,
  TotalityCallerDisconnected,
} from "../../totality/callerLifetime.js";
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

export const DEFAULT_ANTHROPIC_TOTALITY_MODEL = "claude-opus-5-5";
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Thinking cannot be turned off on the default model and counts against
 * `max_tokens`, which Totality caps at 4096 by default. Low effort keeps the
 * thinking short enough to leave room for the JSON draft.
 */
const DEFAULT_EFFORT = "low";
const EFFORTS = ["low", "medium", "high"] as const;
type AnthropicTotalityEffort = (typeof EFFORTS)[number];
/** Server-side refusal fallback; the request is re-run on a fallback model when declined. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicTotalityResult {
  responseId: string | null;
  draft: TotalityDraft;
  modelUsage?: {
    provider: "anthropic";
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

export interface AnthropicTotalityConfig {
  apiKey: string;
  model: string;
  effort: AnthropicTotalityEffort;
  timeoutMs: number;
  maxOutputTokens: number;
}

export class AnthropicRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnthropicRequestError";
  }
}

type FetchLike = typeof fetch;

function cleanRequiredSecret(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  if (/\s/.test(value)) throw new Error(`${field} must not contain whitespace.`);
  return value;
}

function cleanModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_ANTHROPIC_TOTALITY_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(model)) {
    throw new Error("TOTALITY_ANTHROPIC_MODEL must be a safe model identifier.");
  }
  return model;
}

function cleanEffort(value: string | undefined): AnthropicTotalityEffort {
  const effort = value?.trim().toLowerCase() || DEFAULT_EFFORT;
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error("TOTALITY_ANTHROPIC_EFFORT must be low, medium or high.");
  }
  return effort as AnthropicTotalityEffort;
}

function resolveTimeout(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw new Error("TOTALITY_ANTHROPIC_TIMEOUT_MS must be an integer.");
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("TOTALITY_ANTHROPIC_TIMEOUT_MS must be between 1000 and 300000.");
  }
  return timeoutMs;
}

export function resolveAnthropicTotalityConfig(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicTotalityConfig {
  return {
    apiKey: cleanRequiredSecret(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"),
    model: cleanModel(env.TOTALITY_ANTHROPIC_MODEL),
    effort: cleanEffort(env.TOTALITY_ANTHROPIC_EFFORT),
    timeoutMs: resolveTimeout(env.TOTALITY_ANTHROPIC_TIMEOUT_MS),
    maxOutputTokens: resolveTotalityQuotaConfig(env).maxOutputTokens,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function extractUsage(message: BetaMessage, model: string) {
  const inputTokens = nonNegativeInteger(message.usage?.input_tokens);
  const outputTokens = nonNegativeInteger(message.usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = nonNegativeInteger(message.usage?.cache_read_input_tokens);
  return {
    provider: "anthropic" as const,
    model,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined || cachedInputTokens === 0 ? {} : { cachedInputTokens }),
  };
}

function extractOutputText(message: BetaMessage): string {
  // The termination class is checked before any content is read.
  if (message.stop_reason === "refusal") {
    throw new AnthropicRequestError("Anthropic declined the request.", null, false);
  }
  if (message.stop_reason !== "end_turn") {
    throw new Error(`Anthropic response did not finish normally: ${String(message.stop_reason)}.`);
  }
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  throw new Error("Anthropic response did not contain text content.");
}

function providerMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  if (typeof message === "string" && message.length > 0) return message.slice(0, 300);
  return `Anthropic request failed with status ${String(error.status)}.`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export class AnthropicTotalityReasoner {
  constructor(
    private readonly config: AnthropicTotalityConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private body(
    request: TotalityRequest,
    context: TotalityReasoningContext,
  ): MessageCreateParamsNonStreaming {
    const routing = routeTotalityTask({
      taskType: request.taskType,
      outputStyle: request.outputStyle,
      domainContext: request.domainContext,
    });
    assertRequestAuthority(request, routing);
    return {
      model: this.config.model,
      max_tokens:
        context.maxOutputTokens ??
        this.config.maxOutputTokens ??
        DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS,
      system: TOTALITY_SYSTEM_INSTRUCTIONS,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: request.goal,
            domainContext: request.domainContext,
            constraints: request.constraints,
            inputs: request.inputs,
            routing,
            projectContext: context.project,
            proposalTimestamp: context.proposedAt,
          }),
        },
      ],
      output_config: {
        effort: this.config.effort,
        format: { type: "json_schema", schema: TOTALITY_DRAFT_SCHEMA },
      },
      fallbacks: "default",
    };
  }

  /**
   * Exact credential-free body used for quota admission and provider dispatch.
   * The beta flag travels as a header, so it is not part of the body.
   */
  serializeRequest(request: TotalityRequest, context: TotalityReasoningContext): string {
    return JSON.stringify(this.body(request, context));
  }

  async reason(
    request: TotalityRequest,
    context: TotalityReasoningContext,
    caller?: AbortSignal,
  ): Promise<AnthropicTotalityResult> {
    const body = this.body(request, context);
    const cancellation = linkProviderCancellation({ timeoutMs: this.config.timeoutMs, caller });
    // A body over the byte cap is recorded here; the SDK would otherwise report it
    // as a retryable connection error.
    let boundedReadFailure: Error | undefined;
    const fetchImpl = this.fetchImpl;
    const boundedFetch: FetchLike = async (input, init) => {
      const response = await fetchImpl(input, init);
      let text: string;
      try {
        text = await readBoundedResponseText(response, {
          signal: init?.signal ?? cancellation.signal,
        });
      } catch (error: unknown) {
        if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
          boundedReadFailure = error;
        }
        throw error;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(text, { status: response.status, headers });
    };
    const client = new Anthropic({
      apiKey: this.config.apiKey,
      fetch: boundedFetch,
      maxRetries: 0,
      timeout: this.config.timeoutMs,
    });

    try {
      const message = await client.beta.messages.create(
        { ...body, betas: [FALLBACK_BETA] },
        { signal: cancellation.signal },
      );
      if (caller?.aborted) throw new TotalityCallerDisconnected();
      const draft = parseTotalityDraft(JSON.parse(extractOutputText(message)) as unknown);
      const usage = extractUsage(message, message.model || this.config.model);
      return {
        responseId: typeof message.id === "string" ? message.id : null,
        draft,
        ...(usage ? { modelUsage: usage } : {}),
      };
    } catch (error: unknown) {
      if (boundedReadFailure) {
        throw new AnthropicRequestError(
          `Anthropic response processing failed: ${boundedReadFailure.message}`,
          null,
          false,
        );
      }
      if (caller?.aborted && error instanceof Anthropic.APIUserAbortError) {
        throw new TotalityCallerDisconnected();
      }
      const classified = asCallerDisconnected(caller, error);
      if (classified instanceof TotalityCallerDisconnected) throw classified;
      if (classified instanceof AnthropicRequestError) throw classified;
      if (
        classified instanceof Anthropic.APIConnectionTimeoutError ||
        classified instanceof Anthropic.APIUserAbortError
      ) {
        throw new AnthropicRequestError("Anthropic request timed out.", null, true);
      }
      if (classified instanceof Anthropic.APIConnectionError) {
        throw new AnthropicRequestError("Anthropic network request failed.", null, true);
      }
      if (classified instanceof Anthropic.APIError && typeof classified.status === "number") {
        throw new AnthropicRequestError(
          providerMessage(classified),
          classified.status,
          isRetryableStatus(classified.status),
        );
      }
      const message = classified instanceof Error ? classified.message : String(classified);
      throw new AnthropicRequestError(
        `Anthropic response processing failed: ${message}`,
        null,
        false,
      );
    } finally {
      cancellation.dispose();
    }
  }
}
