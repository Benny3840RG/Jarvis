import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";

export type Capability = {
  operationId: string;
  summary: string;
  mutating: boolean;
  destructive: boolean;
  mcpExposed: boolean;
};

export type HealthResponse = {
  status: "ok";
  service: "jarvis";
  version: string;
  time: string;
};

export type HelpResponse = {
  apiVersion: "v1";
  capabilities: Capability[];
};

export type LayerStatus = {
  status: "ready" | "partial" | "inactive" | "blocked";
  reason?: string;
};

export type LayersStatus = {
  runtime: LayerStatus;
  domains: LayerStatus;
  integration: LayerStatus;
  orchestration: LayerStatus;
  safety: LayerStatus;
  adaptive: LayerStatus;
  autonomy: LayerStatus;
  reliability: LayerStatus;
};

export type ProviderStatus = {
  name: "json" | "convex";
  reachability: "ok" | "unavailable";
  authentication: "not-required" | "ok" | "failed";
  schemaCompatibility: "compatible" | "incompatible" | "unknown";
  deploymentVersion: string | null;
};

/**
 * How far a capability has actually progressed, from code existing to a human
 * approving production use. Each stage is a strictly stronger claim than the one
 * before it and must be backed by evidence *of that kind* — a stronger stage is
 * never inferred from a weaker one. In particular, registering a tool proves its
 * dependencies are wired (`configured`); it proves nothing about whether the
 * real external system has ever been exercised (`commissioned`) or whether an
 * operator has approved production use (`production-approved`).
 */
export type LifecycleStage =
  /** Code exists and is covered by offline tests. Nothing is wired in this deployment. */
  | "implemented"
  /** Every dependency/credential this deployment needs is present and wired. */
  | "configured"
  /** Exercised against the real external system, with the result recorded as evidence. */
  | "commissioned"
  /** A human has approved production use. */
  | "production-approved";

export type IntegrationStatus = {
  name: string;
  /**
   * The highest stage with recorded evidence. Never inferred upward.
   */
  stage: LifecycleStage;
  /**
   * Retained for existing consumers. Derived, never independently asserted:
   * `"commissioned"` only when `stage` is `commissioned` or `production-approved`.
   */
  status: "commissioned" | "not-commissioned";
  /** Why this integration is not further along. Present unless production-approved. */
  reason?: string;
};

/** Derives the legacy two-value field so the two can never disagree. */
export function integrationStatusFromStage(stage: LifecycleStage): IntegrationStatus["status"] {
  return stage === "commissioned" || stage === "production-approved"
    ? "commissioned"
    : "not-commissioned";
}

// Never a live-verified state -- "configured" means the required provider API
// key env var is present, not that the provider has ever been reached. See
// resolveTotalityReasoningStatus in totalityFactory.ts for the single source
// of truth this mirrors.
export type ReasoningStatus = {
  status: "not-configured" | "configured";
  provider: "openai" | "gemini" | null;
  model: string | null;
  reason: string;
};

export type SystemStatus = {
  status: "ok" | "degraded" | "unavailable";
  version: string;
  sourceVersion: string;
  provider: ProviderStatus;
  reconciliation: RuntimeReconciliationHealth;
  integrations: IntegrationStatus[];
  reasoning: ReasoningStatus;
  timezone: string;
  layers: LayersStatus;
  zState: "disabled" | "stabilising" | "active" | "suspended";
  checkedAt: string;
};

export const IMPLEMENTED_CAPABILITIES: readonly Capability[] = [
  {
    operationId: "getHealth",
    summary: "Check process liveness",
    mutating: false,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "getHelp",
    summary: "List supported operator capabilities",
    mutating: false,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "getJarvisStatus",
    summary: "Inspect Jarvis runtime and provider status",
    mutating: false,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "reasonWithTotality",
    summary: "Run proposal-only Totality reasoning with validation and audit journalling",
    mutating: true,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "stageMemoryChangeSet",
    summary: "Stage typed project-memory changes for explicit approval",
    mutating: true,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "listMemoryChangeSets",
    summary: "List staged project-memory change sets",
    mutating: false,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "getMemoryChangeSet",
    summary: "Inspect one project-memory change set",
    mutating: false,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "approveMemoryChangeSet",
    summary: "Approve a revision-matched project-memory change set",
    mutating: true,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "rejectMemoryChangeSet",
    summary: "Reject a staged project-memory change set",
    mutating: true,
    destructive: false,
    mcpExposed: false,
  },
  {
    operationId: "applyMemoryChangeSet",
    summary: "Transactionally apply an approved project-memory change set",
    mutating: true,
    destructive: true,
    mcpExposed: false,
  },
  {
    operationId: "listTasks",
    summary: "List durable tasks",
    mutating: false,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "createTask",
    summary: "Create a durable task",
    mutating: true,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "getTask",
    summary: "Get one durable task",
    mutating: false,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "updateTask",
    summary: "Update a durable task",
    mutating: true,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "deleteTask",
    summary: "Delete a durable task",
    mutating: true,
    destructive: true,
    mcpExposed: true,
  },
  {
    operationId: "completeTask",
    summary: "Complete a durable task",
    mutating: true,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "listReminders",
    summary: "List durable reminders",
    mutating: false,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "createReminder",
    summary: "Create a durable reminder",
    mutating: true,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "getReminder",
    summary: "Get one durable reminder",
    mutating: false,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "updateReminder",
    summary: "Update a durable reminder",
    mutating: true,
    destructive: false,
    mcpExposed: true,
  },
  {
    operationId: "deleteReminder",
    summary: "Delete a durable reminder",
    mutating: true,
    destructive: true,
    mcpExposed: true,
  },
] as const;
