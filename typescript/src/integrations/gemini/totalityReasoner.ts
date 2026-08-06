import type { TotalityRequest } from "../../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../../runtime/totalityContracts.js";
import { routeTotalityTask } from "../../runtime/totalityPolicy.js";
import type { TotalityReasoningContext } from "../../totality/totalityPipeline.js";
import { DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS } from "../../totality/totalityQuota.js";
import {
  parseTotalityDraft,
  TOTALITY_SYSTEM_INSTRUCTIONS,
  type TotalityDraft,
} from "../totalityDraftParsing.js";

const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

export type GeminiTotalityDraft = TotalityDraft;

export interface GeminiTotalityResult {
  responseId: string | null;
  draft: GeminiTotalityDraft;
}

export interface GeminiTotalityConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export class GeminiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

type FetchLike = typeof fetch;

type GeminiCandidate = {
  content?: { parts?: Array<{ text?: unknown }> };
  finishReason?: unknown;
};

type GeminiResponsePayload = {
  responseId?: unknown;
  candidates?: unknown;
  promptFeedback?: { blockReason?: unknown };
  error?: { message?: unknown; status?: unknown };
};

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
    throw new Error("GEMINI_MODEL must be a safe model identifier.");
  }
  return model;
}

function cleanClientRequestId(value: string): string {
  if (value.length === 0 || value.length > 512 || !/^[\x21-\x7E]+$/.test(value)) {
    throw new Error("Gemini client request ID must contain 1 to 512 visible ASCII characters.");
  }
  return value;
}

function resolveTimeout(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw new Error("GEMINI_TIMEOUT_MS must be an integer.");
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("GEMINI_TIMEOUT_MS must be between 1000 and 300000.");
  }
  return timeoutMs;
}

export function resolveGeminiTotalityConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeminiTotalityConfig {
  return {
    apiKey: cleanRequiredSecret(env.GEMINI_API_KEY, "GEMINI_API_KEY"),
    model: cleanModel(env.GEMINI_MODEL),
    timeoutMs: resolveTimeout(env.GEMINI_TIMEOUT_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOutputText(payload: GeminiResponsePayload): string {
  const blockReason = payload.promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason.length > 0) {
    throw new Error(`Gemini blocked the prompt before generation: ${blockReason}.`);
  }

  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    throw new Error("Gemini response did not contain any candidates.");
  }

  const candidate = payload.candidates[0] as GeminiCandidate;
  const finishReason = candidate.finishReason;
  if (typeof finishReason === "string" && finishReason !== "STOP") {
    throw new Error(`Gemini candidate did not finish normally: ${finishReason}.`);
  }

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error("Gemini candidate did not contain content parts.");
  }
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === "string") return part.text;
  }
  throw new Error("Gemini candidate did not contain text content.");
}

function parseResponsePayload(text: string): GeminiResponsePayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? (parsed as GeminiResponsePayload) : null;
  } catch {
    return null;
  }
}

function safeErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return typeof payload.error.message === "string" ? payload.error.message : null;
}

export class GeminiTotalityReasoner {
  constructor(
    private readonly config: GeminiTotalityConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async reason(
    request: TotalityRequest,
    context: TotalityReasoningContext,
  ): Promise<GeminiTotalityResult> {
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
      const response = await this.fetchImpl(
        `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(this.config.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            // The API key travels as a header, never a URL query parameter,
            // so it cannot end up in server access logs, proxy logs, or a
            // Referer header the way a `?key=` query string could.
            "x-goog-api-key": this.config.apiKey,
            "Content-Type": "application/json",
            "X-Client-Request-Id": clientRequestId,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: TOTALITY_SYSTEM_INSTRUCTIONS }] },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: JSON.stringify({
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
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              maxOutputTokens: DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS,
            },
          }),
          signal: controller.signal,
        },
      );

      const responseText = await response.text();
      const payload = parseResponsePayload(responseText);
      if (!response.ok) {
        const message =
          safeErrorMessage(payload) ?? `Gemini request failed with status ${response.status}.`;
        throw new GeminiRequestError(
          message,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      if (payload === null) {
        throw new Error("Gemini returned a non-JSON success response.");
      }

      const outputText = extractOutputText(payload);
      const parsed = parseTotalityDraft(JSON.parse(outputText) as unknown);
      return {
        responseId: typeof payload.responseId === "string" ? payload.responseId : null,
        draft: parsed,
      };
    } catch (error: unknown) {
      if (error instanceof GeminiRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GeminiRequestError("Gemini request timed out.", null, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        throw new GeminiRequestError(`Gemini network request failed: ${message}`, null, true);
      }
      throw new GeminiRequestError(`Gemini response processing failed: ${message}`, null, false);
    } finally {
      clearTimeout(timeout);
    }
  }
}
