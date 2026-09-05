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

export type IntegrationStatus = {
  name: string;
  status: "commissioned" | "not-commissioned";
  reason?: string;
};

export type ReasoningConfigurationStatus =
  | {
      status: "configured";
      provider: "openai" | "gemini";
      model: string;
      observability: "configuration-only";
    }
  | {
      status: "not-configured";
      reason: string;
      observability: "configuration-only";
    };

export type SystemStatus = {
  status: "ok" | "degraded" | "unavailable";
  version: string;
  sourceVersion: string;
  provider: ProviderStatus;
  reasoning: ReasoningConfigurationStatus;
  reconciliation: RuntimeReconciliationHealth;
  integrations: IntegrationStatus[];
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
