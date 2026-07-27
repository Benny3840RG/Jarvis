import { randomUUID } from "node:crypto";

export type RuntimeReconciliationState =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "degraded";

export type RuntimeReconciliationHealth = {
  state: RuntimeReconciliationState;
  enabled: boolean;
  workerId?: string;
  startedAt?: string;
  lastCycleStartedAt?: string;
  lastCycleCompletedAt?: string;
  lastCycleProcessed?: number;
  lastErrorCode?: string;
};

export type DisabledRuntimeReconciliationConfig = {
  enabled: false;
  state: "disabled";
};

export type EnabledRuntimeReconciliationConfig = {
  enabled: true;
  convexUrl: string;
  convexDeployment: string;
  serviceToken: string;
  workerId: string;
  leaseMs: number;
  intervalMs: number;
  maxBatchSize: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
};

export type RuntimeReconciliationConfig =
  | DisabledRuntimeReconciliationConfig
  | EnabledRuntimeReconciliationConfig;

type Environment = Readonly<Record<string, string | undefined>>;

export type EnabledReconciliationRuntime = {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): RuntimeReconciliationHealth;
};

export type RuntimeReconciliationFactories = {
  createEnabledRuntime(\n    config: EnabledRuntimeReconciliationConfig,\n  ): EnabledReconciliationRuntime;
};

export type RuntimeReconciliationHost = {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): RuntimeReconciliationHealth;
};

const DEFAULTS = {
  leaseMs: 30_000,
  intervalMs: 5_000,
  maxBatchSize: 10,
  maxAttempts: 5,
  baseRetryMs: 1_000,
  maxRetryMs: 60_000,
} as const;

function requireNonEmpty(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when reconciliation is enabled.`);
  return value;
}

function parsePositiveSafeInteger(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== raw.trim()) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function parseBoundedInteger(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const value = parsePositiveSafeInteger(environment, name, fallback);
  if (value > 100) throw new Error(`${name} must be between 1 and 100.`);
  return value;
}

function resolveWorkerId(environment: Environment): string {
  const value =\n    environment.JARVIS_RECONCILIATION_WORKER_ID?.trim() ?? `runtime-${randomUUID()}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(
      "JARVIS_RECONCILIATION_WORKER_ID must be a safe identifier of 1 to 128 characters.",
    );
  }
  return value;
}

export function resolveRuntimeReconciliationConfig(
  environment: Environment = process.env,
): RuntimeReconciliationConfig {
  const enabledValue = environment.JARVIS_RECONCILIATION_ENABLED;
  if (enabledValue === undefined || enabledValue === "false") {
    return { enabled: false, state: "disabled" };
  }
  if (enabledValue !== "true") {
    throw new Error("JARVIS_RECONCILIATION_ENABLED must be true or false.");
  }

  const baseRetryMs = parsePositiveSafeInteger(
    environment,
    "JARVIS_RECONCILIATION_BASE_RETRY_MS",
    DEFAULTS.baseRetryMs,
  );
  const maxRetryMs = parsePositiveSafeInteger(
    environment,
    "JARVIS_RECONCILIATION_MAX_RETRY_MS",
    DEFAULTS.maxRetryMs,
  );
  if (maxRetryMs < baseRetryMs) {
    throw new Error(
      "JARVIS_RECONCILIATION_MAX_RETRY_MS must be greater than or equal to BASE_RETRY_MS.",
    );
  }

  return {
    enabled: true,
    convexUrl: requireNonEmpty(environment, "CONVEX_URL"),
    convexDeployment: requireNonEmpty(environment, "CONVEX_DEPLOYMENT"),
    serviceToken: requireNonEmpty(environment, "JARVIS_SERVICE_TOKEN"),
    workerId: resolveWorkerId(environment),
    leaseMs: parsePositiveSafeInteger(
      environment,
      "JARVIS_RECONCILIATION_LEASE_MS",
      DEFAULTS.leaseMs,
    ),
    intervalMs: parsePositiveSafeInteger(
      environment,
      "JARVIS_RECONCILIATION_INTERVAL_MS",
      DEFAULTS.intervalMs,
    ),
    maxBatchSize: parseBoundedInteger(
      environment,
      "JARVIS_RECONCILIATION_BATCH_SIZE",
      DEFAULTS.maxBatchSize,
    ),
    maxAttempts: parseBoundedInteger(
      environment,
      "JARVIS_RECONCILIATION_MAX_ATTEMPTS",
      DEFAULTS.maxAttempts,
    ),
    baseRetryMs,
    maxRetryMs,
  };
}

class DisabledReconciliationHost implements RuntimeReconciliationHost {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  health(): RuntimeReconciliationHealth {
    return { state: "disabled", enabled: false };
  }
}

class EnabledReconciliationHost implements RuntimeReconciliationHost {
  constructor(private readonly runtime: EnabledReconciliationRuntime) {}

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  health(): RuntimeReconciliationHealth {
    return this.runtime.health();
  }
}

export function createRuntimeReconciliationHost(
  environment: Environment = process.env,
  factories?: RuntimeReconciliationFactories,
): RuntimeReconciliationHost {
  const config = resolveRuntimeReconciliationConfig(environment);
  if (!config.enabled) return new DisabledReconciliationHost();
  if (!factories) {
    throw new Error("Enabled reconciliation runtime factories are required.");
  }
  return new EnabledReconciliationHost(factories.createEnabledRuntime(config));
}
