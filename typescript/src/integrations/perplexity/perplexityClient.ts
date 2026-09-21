const PERPLEXITY_CHAT_COMPLETIONS_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 30_000;

export type PerplexityConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type PerplexitySearchResult = {
  answer: string;
  citations: string[];
};

type FetchLike = typeof fetch;

export class PerplexityRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PerplexityRequestError";
  }
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
    throw new Error("PERPLEXITY_MODEL must be a safe model identifier.");
  }
  return model;
}

function resolveTimeout(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw new Error("PERPLEXITY_TIMEOUT_MS must be an integer.");
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("PERPLEXITY_TIMEOUT_MS must be between 1000 and 300000.");
  }
  return timeoutMs;
}

export function resolvePerplexityConfig(env: NodeJS.ProcessEnv = process.env): PerplexityConfig {
  return {
    apiKey: cleanRequiredSecret(env.PERPLEXITY_API_KEY, "PERPLEXITY_API_KEY"),
    model: cleanModel(env.PERPLEXITY_MODEL),
    timeoutMs: resolveTimeout(env.PERPLEXITY_TIMEOUT_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponsePayload(text: string): Record<string, unknown> | null {
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

function extractAnswer(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice) || !isRecord(choice.message)) continue;
      if (typeof choice.message.content === "string" && choice.message.content.length > 0) {
        return choice.message.content;
      }
    }
  }
  throw new Error("Perplexity response did not contain an answer.");
}

function extractCitations(payload: Record<string, unknown>): string[] {
  const citations = payload.citations;
  if (!Array.isArray(citations)) return [];
  return citations.filter((citation): citation is string => typeof citation === "string");
}

export class PerplexityClient {
  constructor(
    private readonly config: PerplexityConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async search(query: string): Promise<PerplexitySearchResult> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      throw new Error("Perplexity search query must not be empty.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(PERPLEXITY_CHAT_COMPLETIONS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: trimmedQuery }],
        }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      const payload = parseResponsePayload(responseText);
      if (!response.ok) {
        const message =
          safeErrorMessage(payload) ?? `Perplexity request failed with status ${response.status}.`;
        throw new PerplexityRequestError(
          message,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      if (payload === null) {
        throw new Error("Perplexity returned a non-JSON success response.");
      }

      return {
        answer: extractAnswer(payload),
        citations: extractCitations(payload),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
