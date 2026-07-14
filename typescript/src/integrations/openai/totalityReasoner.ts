import type { TotalityRequest } from "../../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../../runtime/totalityContracts.js";
import { routeTotalityTask } from "../../runtime/totalityPolicy.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6";
const DEFAULT_TIMEOUT_MS = 60_000;

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
  },
  required: [
    "answer",
    "assumptions",
    "unknowns",
    "risks",
    "controls",
    "unsupportedClaims",
    "contradictions",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_INSTRUCTIONS = `You are Jarvis Prime Omni TOTALITY, a technical reasoning engine for Benny.
Return only the requested structured draft.
Separate assumptions and unknowns from supported conclusions.
Identify hazards and practical controls.
Do not claim external actions were performed.
Do not grant yourself tool authority, approvals, or execution permission.
Do not invent measurements, tools, project history, or source material.`;

export interface OpenAITotalityDraft {
  answer: string;
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  controls: string[];
  unsupportedClaims: string[];
  contradictions: string[];
}

export interface OpenAITotalityResult {
  responseId: string | null;
  draft: OpenAITotalityDraft;
}

export interface OpenAITotalityConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
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
};

type DraftArrayField = Exclude<keyof OpenAITotalityDraft, "answer">;

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
    throw new Error(
      "OpenAI client request ID must contain 1 to 512 visible ASCII characters.",
    );
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireStringArray(value: Record<string, unknown>, field: DraftArrayField): string[] {
  const candidate = value[field];
  if (!isStringArray(candidate)) {
    throw new Error(`OpenAI Totality draft field ${field} must be an array of strings.`);
  }
  return candidate;
}

function parseDraft(value: unknown): OpenAITotalityDraft {
  if (!isRecord(value)) throw new Error("OpenAI returned a non-object Totality draft.");
  if (typeof value.answer !== "string") {
    throw new Error("OpenAI Totality draft is missing answer text.");
  }

  return {
    answer: value.answer,
    assumptions: requireStringArray(value, "assumptions"),
    unknowns: requireStringArray(value, "unknowns"),
    risks: requireStringArray(value, "risks"),
    controls: requireStringArray(value, "controls"),
    unsupportedClaims: requireStringArray(value, "unsupportedClaims"),
    contradictions: requireStringArray(value, "contradictions"),
  };
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

  async reason(request: TotalityRequest): Promise<OpenAITotalityResult> {
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
          instructions: SYSTEM_INSTRUCTIONS,
          input: JSON.stringify({
            goal: request.goal,
            domainContext: request.domainContext,
            constraints: request.constraints,
            inputs: request.inputs,
            routing,
          }),
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "jarvis_totality_draft",
              description: "A proposal-only technical reasoning draft for local validation.",
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
      const parsed = parseDraft(JSON.parse(outputText) as unknown);
      return {
        responseId: typeof payload.id === "string" ? payload.id : null,
        draft: parsed,
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
