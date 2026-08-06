import type { TotalityRequest } from "../runtime/totalityContracts.js";

export const DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS = 4_096;

export type TotalityQuotaConfig = {
  maxRequestBytes: number;
  maxEstimatedInputTokens: number;
  maxConcurrentRequests: number;
  maxCostUnitsPerWindow: number;
  maxOutputTokens: number;
  windowMs: number;
};

export type TotalityQuotaErrorCode =
  "request-too-large" | "input-token-limit" | "concurrency-limit" | "provider-cost-quota";

export class TotalityQuotaError extends Error {
  constructor(readonly code: TotalityQuotaErrorCode) {
    super(`Totality provider quota rejected the request: ${code}.`);
    this.name = "TotalityQuotaError";
  }
}

export type TotalityQuotaLease = { release(): void };

function requestBytes(request: TotalityRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

export class TotalityQuota {
  private activeRequests = 0;
  private windowStartedAt = 0;
  private reservedCostUnits = 0;

  constructor(
    private readonly config: TotalityQuotaConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get maxOutputTokens(): number {
    return this.config.maxOutputTokens;
  }

  acquire(request: TotalityRequest): TotalityQuotaLease {
    const bytes = requestBytes(request);
    if (bytes > this.config.maxRequestBytes) throw new TotalityQuotaError("request-too-large");

    const estimatedInputTokens = Math.ceil(bytes / 4);
    if (estimatedInputTokens > this.config.maxEstimatedInputTokens) {
      throw new TotalityQuotaError("input-token-limit");
    }

    const currentTime = this.now();
    if (this.windowStartedAt === 0 || currentTime - this.windowStartedAt >= this.config.windowMs) {
      this.windowStartedAt = currentTime;
      this.reservedCostUnits = 0;
    }

    if (this.activeRequests >= this.config.maxConcurrentRequests) {
      throw new TotalityQuotaError("concurrency-limit");
    }

    const costUnits = estimatedInputTokens + this.config.maxOutputTokens;
    if (this.reservedCostUnits + costUnits > this.config.maxCostUnitsPerWindow) {
      throw new TotalityQuotaError("provider-cost-quota");
    }

    this.activeRequests += 1;
    this.reservedCostUnits += costUnits;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeRequests -= 1;
      },
    };
  }
}

function boundedInteger(
  value: string | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function resolveTotalityQuotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): TotalityQuotaConfig {
  const maxRequestBytes = boundedInteger(
    env.JARVIS_TOTALITY_MAX_REQUEST_BYTES,
    "JARVIS_TOTALITY_MAX_REQUEST_BYTES",
    262_144,
    1_024,
    1_048_576,
  );
  const maxEstimatedInputTokens = boundedInteger(
    env.JARVIS_TOTALITY_MAX_INPUT_TOKENS,
    "JARVIS_TOTALITY_MAX_INPUT_TOKENS",
    32_768,
    256,
    131_072,
  );
  const maxConcurrentRequests = boundedInteger(
    env.JARVIS_TOTALITY_MAX_CONCURRENT,
    "JARVIS_TOTALITY_MAX_CONCURRENT",
    4,
    1,
    32,
  );
  const maxCostUnitsPerWindow = boundedInteger(
    env.JARVIS_TOTALITY_COST_UNITS_PER_WINDOW,
    "JARVIS_TOTALITY_COST_UNITS_PER_WINDOW",
    100_000,
    1_024,
    10_000_000,
  );
  const maxOutputTokens = boundedInteger(
    env.JARVIS_TOTALITY_MAX_OUTPUT_TOKENS,
    "JARVIS_TOTALITY_MAX_OUTPUT_TOKENS",
    DEFAULT_TOTALITY_MAX_OUTPUT_TOKENS,
    256,
    16_384,
  );
  const windowMs = boundedInteger(
    env.JARVIS_TOTALITY_QUOTA_WINDOW_MS,
    "JARVIS_TOTALITY_QUOTA_WINDOW_MS",
    3_600_000,
    1_000,
    86_400_000,
  );
  if (maxCostUnitsPerWindow < maxOutputTokens) {
    throw new Error(
      "JARVIS_TOTALITY_COST_UNITS_PER_WINDOW must be at least JARVIS_TOTALITY_MAX_OUTPUT_TOKENS.",
    );
  }
  return {
    maxRequestBytes,
    maxEstimatedInputTokens,
    maxConcurrentRequests,
    maxCostUnitsPerWindow,
    maxOutputTokens,
    windowMs,
  };
}
