import { readFileSync } from "node:fs";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Client } from "../clients/client.js";
import type { Build } from "../builds/build.js";
import type { BuildLogEntry } from "../buildLog/buildLogEntry.js";
import type { Upgrade } from "../upgrades/upgrade.js";
import type { AssetView } from "../assets/assetView.js";
import type { Preference } from "../preferences/preference.js";
import type { Errand } from "../errands/errand.js";
import type { Project } from "../projects/project.js";
import type { QuoteSnapshot } from "../quotes/quoteLifecycle.js";
import type { ToolAction } from "../actions/toolActions.js";
import type { Reminder, Task } from "../persistence/persistence.js";
import {
  JarvisApiClient,
  JarvisApiError,
  type DashboardSnapshot,
  type ReminderRequestUpdate,
} from "./jarvisApiClient.js";
import { JARVIS_INSTRUCTIONS, JARVIS_PERSONA_MARKDOWN, JARVIS_PERSONA_URI } from "./persona.js";

export const JARVIS_DASHBOARD_URI = "ui://jarvis/dashboard-v1.html";

const dashboardHtml = readFileSync(new URL("./dashboard-v1.html", import.meta.url), "utf8");

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  category: z.string(),
  createdAt: z.number(),
});

const reminderSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueRaw: z.string().optional(),
  dueAt: z.number().optional(),
  dueTimezone: z.string().optional(),
  createdAt: z.number(),
});

const clientContactSchema = z.object({
  label: z.string().optional(),
  value: z.string(),
});

const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  contacts: z.array(clientContactSchema),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const projectSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  title: z.string(),
  status: z.enum(["lead", "quoted", "active", "on_hold", "done"]),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const quoteLineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});

const quoteSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  projectId: z.string().optional(),
  number: z.string(),
  status: z.enum(["draft", "sent", "accepted", "declined"]),
  lineItems: z.array(quoteLineItemSchema),
  subtotal: z.number(),
  taxRate: z.number().optional(),
  tax: z.number(),
  total: z.number(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const quoteSummarySchema = z.object({
  quoteId: z.string(),
  clientId: z.string(),
  projectId: z.string().optional(),
  number: z.string(),
  currentRevision: z.number().int().positive(),
  aggregateVersion: z.number().int().nonnegative(),
  revisionStatus: z.enum(["draft", "reviewed", "finalized"]),
  commercialStatus: z.enum(["open", "accepted", "declined", "expired"]),
  total: z.number().nonnegative(),
  currency: z.literal("AUD"),
  updatedAt: z.number(),
});

const quoteAggregateSchema = z.object({
  quoteId: z.string(),
  ownerId: z.string(),
  clientId: z.string(),
  projectId: z.string().optional(),
  number: z.string(),
  currentRevision: z.number().int().positive(),
  currentRevisionId: z.string(),
  aggregateVersion: z.number().int().nonnegative(),
  commercialStatus: z.enum(["open", "accepted", "declined", "expired"]),
  commercialRevision: z.number().int().positive().optional(),
  commercialRecordedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const quoteRevisionSchema = z.object({
  revisionId: z.string(),
  ownerId: z.string(),
  quoteId: z.string(),
  revision: z.number().int().positive(),
  revisionVersion: z.number().int().nonnegative(),
  status: z.enum(["draft", "reviewed", "finalized"]),
  lineItems: z.array(quoteLineItemSchema),
  subtotal: z.number().nonnegative(),
  taxRate: z.number().nonnegative().max(1).optional(),
  tax: z.number().nonnegative(),
  total: z.number().nonnegative(),
  currency: z.literal("AUD"),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  termsIncluded: z.boolean(),
  fingerprint: z.string().optional(),
  predecessorRevisionId: z.string().optional(),
  historicalOutcome: z.enum(["accepted", "declined", "expired"]).optional(),
  historicalOutcomeRecordedAt: z.number().optional(),
  reviewedAt: z.number().optional(),
  finalizedAt: z.number().optional(),
  source: z.literal("legacy-migration").optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const quoteSnapshotSchema = z.object({
  aggregate: quoteAggregateSchema,
  revision: quoteRevisionSchema,
});

// Consent-lifecycle inspection (R-048/R-049/R-050): read-only. Mirrors the
// ToolAction shape exactly; no schema here ever represents approve, revoke,
// reject, or execute — those remain unavailable through MCP in this slice.
const toolActionSchema = z.object({
  actionId: z.string(),
  requestId: z.string(),
  projectId: z.string(),
  baseRevision: z.number().int(),
  state: z.enum(["proposed", "approved", "rejected", "expired", "revoked"]),
  tool: z.string(),
  operation: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  requiredAuthority: z.enum(["T0", "T1", "T2", "T3"]),
  destructive: z.boolean(),
  idempotencyKey: z.string(),
  proposedBy: z.enum(["user", "agent", "tool"]),
  approvedBy: z.literal("user").optional(),
  rejectedBy: z.literal("user").optional(),
  rejectedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().optional(),
  rejectedAt: z.string().optional(),
  approvalExpiryPolicy: z.enum(["ttl", "non-expiring"]).optional(),
  approvalExpiresAt: z.string().optional(),
  expiredObservedAt: z.string().optional(),
  consumptionPolicy: z.enum(["single-use", "reusable"]).optional(),
  revokedBy: z.literal("user").optional(),
  revokedReason: z.string().optional(),
  revokedAt: z.string().optional(),
  isApprovalExpired: z.boolean().optional(),
});

const errandLocationSchema = z.object({
  label: z.string(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

const errandSchema = z.object({
  id: z.string(),
  title: z.string(),
  quantity: z.number().optional(),
  status: z.enum(["open", "done"]),
  location: errandLocationSchema.optional(),
  projectId: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
});

// Location input mirrors the HTTP contract: label required, coordinates only
// meaningful as a pair, resolved by the assistant's maps tooling beforehand.
const errandLocationInputSchema = z.object({
  label: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

const buildSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: z.enum(["planning", "active", "shelved", "retired"]),
  description: z.string().optional(),
  nickname: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const buildLogSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  kind: z.enum(["origin", "milestone", "failure", "anecdote", "note"]),
  title: z.string(),
  body: z.string().optional(),
  occurredAt: z.number().optional(),
  createdAt: z.number(),
});

const upgradeSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  beforeState: z.string().optional(),
  afterState: z.string().optional(),
  outcome: z.string().optional(),
  parts: z.array(z.string()).optional(),
  version: z.string().optional(),
  occurredAt: z.number().optional(),
  createdAt: z.number(),
});

const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  serviceIntervalDays: z.number().int().optional(),
  lastServicedAt: z.number().optional(),
  notes: z.string().optional(),
  nextDueAt: z.number().optional(),
  due: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const preferenceSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  category: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const briefSchema = z.object({
  generatedAt: z.string(),
  timezone: z.string(),
  headline: z.string(),
  tasks: z.object({
    openCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    open: z.array(taskSchema),
  }),
  reminders: z.object({
    dueCount: z.number().int().nonnegative(),
    upcomingCount: z.number().int().nonnegative(),
    undatedCount: z.number().int().nonnegative(),
    due: z.array(reminderSchema),
    upcoming: z.array(reminderSchema),
  }),
  projects: z.object({
    activeCount: z.number().int().nonnegative(),
    countsByStatus: z.object({
      lead: z.number().int().nonnegative(),
      quoted: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      on_hold: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
    }),
    active: z.array(projectSchema),
  }),
  quotes: z.object({
    countsByStatus: z.object({
      draft: z.number().int().nonnegative(),
      sent: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      declined: z.number().int().nonnegative(),
    }),
    pipelineTotal: z.number().nonnegative(),
    acceptedTotal: z.number().nonnegative(),
    awaitingResponse: z.array(quoteSchema),
    drafts: z.array(quoteSchema),
  }),
  maintenance: z.object({
    dueCount: z.number().int().nonnegative(),
    dueSoonCount: z.number().int().nonnegative(),
    due: z.array(assetSchema),
    dueSoon: z.array(assetSchema),
  }),
});

// Read-only. Mirrors OperationsInbox exactly; no schema here ever represents
// dismissing, acknowledging, resolving, approving, revoking, or executing.
const inboxSourceReportSchema = z.object({
  source: z.enum(["reminders", "maintenance", "toolActions", "reconciliation", "quoteDelivery"]),
  status: z.enum(["available", "unavailable", "degraded", "unsupported"]),
  reason: z.string().optional(),
  checkedAt: z.string(),
});

const inboxItemSchema = z.object({
  itemId: z.string(),
  kind: z.enum(["reminder-overdue", "maintenance-overdue", "maintenance-due-soon"]),
  severity: z.enum(["critical", "high", "elevated", "normal", "informational"]),
  title: z.string(),
  explanation: z.string(),
  sourceSubsystem: z.enum([
    "reminders",
    "maintenance",
    "toolActions",
    "reconciliation",
    "quoteDelivery",
  ]),
  sourceRecordId: z.string(),
  createdAt: z.string(),
  dueAt: z.string().optional(),
  updatedAt: z.string(),
  status: z.string(),
  actionRequired: z.boolean(),
});

const operationsInboxSchema = z.object({
  generatedAt: z.string(),
  items: z.array(inboxItemSchema),
  sources: z.array(inboxSourceReportSchema),
});

// Read-only. Every summary is built server-side from a fixed per-event-type
// whitelist of known-safe fields — never the raw event payload — so this
// schema never needs (and must never gain) a raw `payload` passthrough field.
const activityEventSchema = z.object({
  activityId: z.string(),
  occurredAt: z.string(),
  eventType: z.string(),
  actor: z.enum(["user", "agent", "tool"]),
  summary: z.string(),
  projectKey: z.string().optional(),
});

const activityTimelineResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    events: z.array(activityEventSchema),
    cursor: z.string(),
    isDone: z.boolean(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string(),
  }),
]);

const layerSchema = z.object({
  status: z.enum(["ready", "partial", "inactive", "blocked"]),
  reason: z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable"]),
  version: z.string(),
  sourceVersion: z.string(),
  provider: z.object({
    name: z.enum(["json", "convex"]),
    reachability: z.enum(["ok", "unavailable"]),
    authentication: z.enum(["not-required", "ok", "failed"]),
    schemaCompatibility: z.enum(["compatible", "incompatible", "unknown"]),
    deploymentVersion: z.string().nullable(),
  }),
  reconciliation: z.object({
    state: z.enum(["disabled", "starting", "running", "stopping", "stopped", "degraded"]),
    enabled: z.boolean(),
    workerId: z.string().optional(),
    startedAt: z.string().optional(),
    lastCycleStartedAt: z.string().optional(),
    lastCycleCompletedAt: z.string().optional(),
    lastCycleProcessed: z.number().int().nonnegative().optional(),
    lastErrorCode: z.string().optional(),
  }),
  integrations: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["commissioned", "not-commissioned"]),
      reason: z.string().optional(),
    }),
  ),
  timezone: z.string(),
  layers: z.object({
    runtime: layerSchema,
    domains: layerSchema,
    integration: layerSchema,
    orchestration: layerSchema,
    safety: layerSchema,
    adaptive: layerSchema,
    autonomy: layerSchema,
    reliability: layerSchema,
  }),
  zState: z.enum(["disabled", "stabilising", "active", "suspended"]),
  checkedAt: z.string(),
});

const countsSchema = z.object({
  activeTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
  reminders: z.number().int().nonnegative(),
});

const hudRegisterStatusSchema = z.enum(["ready", "unavailable"]);
const hudEnquirySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  propertyId: z.string().optional(),
  source: z.string(),
  requestedWork: z.string(),
  urgency: z.enum(["standard", "urgent", "emergency"]),
  status: z.enum(["open", "converted", "closed"]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const hudInvoiceSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  number: z.string(),
  status: z.enum(["draft", "issued", "paid", "void"]),
  paymentStatus: z.enum(["unpaid", "partial", "paid", "overpaid"]),
  total: z.number(),
  amountPaid: z.number(),
  balanceDue: z.number(),
  dueDate: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const hudPropertySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  address: z.string(),
  hazards: z.array(z.string()),
  accessNotes: z.string().optional(),
  serviceNotes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const hudClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  contacts: z.array(z.object({ label: z.string().optional(), value: z.string() })),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const dashboardOutputSchema = {
  status: statusSchema,
  tasks: z.array(taskSchema),
  reminders: z.array(reminderSchema),
  brief: briefSchema,
  quoteRegister: z.object({
    status: z.enum(["ready", "unavailable"]),
    quotes: z.array(quoteSummarySchema),
  }),
  // `null` means the inbox/activity endpoint itself could not be reached —
  // distinct from an empty inbox, or from activity's own `{status:
  // "unavailable"}` — and must never be rendered as "nothing needs attention".
  inbox: operationsInboxSchema.nullable(),
  activity: activityTimelineResultSchema.nullable(),
  approvals: z.object({
    status: hudRegisterStatusSchema,
    items: z.array(toolActionSchema),
  }),
  reconciliations: z.object({
    status: hudRegisterStatusSchema,
    items: z.array(
      z.object({
        actionId: z.string(),
        state: z.string(),
        terminalStatus: z.enum(["succeeded", "failed"]).optional(),
        receiptId: z.string().optional(),
      }),
    ),
  }),
  receipts: z.object({
    status: hudRegisterStatusSchema,
    items: z.array(
      z.object({
        receiptId: z.string(),
        actionId: z.string(),
        projectId: z.string(),
        idempotencyKey: z.string(),
        executionMode: z.enum(["live", "dry-run"]),
        tool: z.string(),
        operation: z.string(),
        status: z.enum(["dry-run", "succeeded", "failed", "indeterminate", "blocked"]),
        errorCode: z.string().optional(),
        startedAt: z.string(),
        completedAt: z.string(),
      }),
    ),
    observations: z.array(
      z.object({
        actionId: z.string(),
        status: z.enum(["ready", "unavailable", "unqueried"]),
      }),
    ),
  }),
  business: z.object({
    clients: z.object({ status: hudRegisterStatusSchema, items: z.array(hudClientSchema) }),
    properties: z.object({ status: hudRegisterStatusSchema, items: z.array(hudPropertySchema) }),
    enquiries: z.object({ status: hudRegisterStatusSchema, items: z.array(hudEnquirySchema) }),
    invoices: z.object({ status: hudRegisterStatusSchema, items: z.array(hudInvoiceSchema) }),
  }),
  presence: z.enum([
    "connecting",
    "idle",
    "waiting_for_approval",
    "reconciling",
    "blocked",
    "degraded",
    "error",
    "offline",
  ]),
  counts: countsSchema,
};

const dashboardMeta = {
  ui: {
    resourceUri: JARVIS_DASHBOARD_URI,
    visibility: ["model", "app"] as const,
  },
  "openai/outputTemplate": JARVIS_DASHBOARD_URI,
  "openai/toolInvocation/invoking": "Checking Jarvis…",
  "openai/toolInvocation/invoked": "Jarvis dashboard ready.",
};

const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

const destructiveAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: true,
} as const;

function dashboardResult(snapshot: DashboardSnapshot, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: snapshot,
  };
}

function taskResult(task: Task, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { task },
  };
}

function reminderResult(reminder: Reminder, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { reminder },
  };
}

function clientResult(client: Client, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { client },
  };
}

function projectResult(project: Project, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { project },
  };
}

function errandResult(errand: Errand, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { errand },
  };
}

function buildResult(build: Build, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { build },
  };
}

function buildLogResult(entry: BuildLogEntry, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { entry },
  };
}

function upgradeResult(upgrade: Upgrade, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { upgrade },
  };
}

function assetResult(asset: AssetView, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { asset },
  };
}

function preferenceResult(preference: Preference, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { preference },
  };
}

function safeError(error: unknown) {
  const message =
    error instanceof JarvisApiError
      ? `${error.message}${error.requestId ? ` Request ID: ${error.requestId}.` : ""}`
      : "Jarvis preview could not complete the request.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function refreshedDashboard(
  client: JarvisApiClient,
  message: string,
): Promise<ReturnType<typeof dashboardResult>> {
  return dashboardResult(await client.dashboard(), message);
}

export function createJarvisMcpServer(client: JarvisApiClient): McpServer {
  const server = new McpServer(
    {
      name: "jarvis-private-preview",
      version: "0.1.0",
    },
    { instructions: JARVIS_INSTRUCTIONS },
  );

  // Jarvis's full persona charter, readable on demand. Plain markdown, not a UI
  // resource — it describes how Jarvis should sound, not something to render.
  server.registerResource(
    "jarvis-persona",
    JARVIS_PERSONA_URI,
    {
      title: "Jarvis persona (Beez Treez)",
      description: "The voice, priorities, and honesty guardrails Jarvis operates by for Benny.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        { uri: JARVIS_PERSONA_URI, mimeType: "text/markdown", text: JARVIS_PERSONA_MARKDOWN },
      ],
    }),
  );

  registerAppResource(server, "jarvis-dashboard", JARVIS_DASHBOARD_URI, {}, async () => ({
    contents: [
      {
        uri: JARVIS_DASHBOARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dashboardHtml,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
          "openai/widgetDescription":
            "Private Jarvis operator console showing live development status, tasks and reminders.",
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "show_jarvis_dashboard",
    {
      title: "Show Jarvis dashboard",
      description:
        "Use this when Benny wants to open the Jarvis operator console or see status, tasks and reminders together.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: readAnnotations,
      _meta: dashboardMeta,
    },
    async () => {
      try {
        return dashboardResult(await client.dashboard(), "Jarvis operator console is ready.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_jarvis_status",
    {
      title: "Check Jarvis status",
      description:
        "Use this when the user asks whether Jarvis, Convex, Z-State or the safety layers are healthy.",
      inputSchema: {},
      outputSchema: { status: statusSchema },
      annotations: readAnnotations,
      _meta: {
        ui: { resourceUri: JARVIS_DASHBOARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": JARVIS_DASHBOARD_URI,
      },
    },
    async () => {
      try {
        const status = await client.getStatus();
        return {
          content: [{ type: "text" as const, text: `Jarvis status is ${status.status}.` }],
          structuredContent: { status },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_tasks",
    {
      title: "List Jarvis tasks",
      description: "Use this when the user asks to see current or completed Jarvis tasks.",
      inputSchema: {},
      outputSchema: { tasks: z.array(taskSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: {
        ui: { resourceUri: JARVIS_DASHBOARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": JARVIS_DASHBOARD_URI,
      },
    },
    async () => {
      try {
        const tasks = await client.listTasks();
        return {
          content: [{ type: "text" as const, text: `Found ${tasks.length} Jarvis tasks.` }],
          structuredContent: { tasks, count: tasks.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_task",
    {
      title: "Get Jarvis task",
      description: "Use this when the user asks for the details of one Jarvis task by ID.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: { task: taskSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ taskId }) => {
      try {
        const task = await client.getTask(taskId);
        return taskResult(task, `Task: ${task.title}`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_task",
    {
      title: "Create Jarvis task",
      description: "Use this when the user explicitly asks to add a durable Jarvis task.",
      inputSchema: {
        title: z.string().trim().min(1).max(100),
        category: z.string().trim().min(1).max(100).optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: createAnnotations,
      _meta: dashboardMeta,
    },
    async ({ title, category }) => {
      try {
        const task = await client.createTask(title, category);
        return refreshedDashboard(client, `Created task "${task.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_task",
    {
      title: "Update Jarvis task",
      description:
        "Use this when the user explicitly asks to change the title or category of an existing Jarvis task.",
      inputSchema: {
        taskId: z.string().min(1),
        title: z.string().trim().min(1).max(100).optional(),
        category: z.string().trim().min(1).max(100).optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: writeAnnotations,
      _meta: dashboardMeta,
    },
    async ({ taskId, title, category }) => {
      try {
        if (title === undefined && category === undefined) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Task update requires a title or category." }],
          };
        }
        const task = await client.updateTask(taskId, {
          ...(title === undefined ? {} : { title }),
          ...(category === undefined ? {} : { category }),
        });
        return refreshedDashboard(client, `Updated task "${task.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "complete_task",
    {
      title: "Complete Jarvis task",
      description: "Use this when the user explicitly asks to mark one Jarvis task complete.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: dashboardOutputSchema,
      annotations: writeAnnotations,
      _meta: dashboardMeta,
    },
    async ({ taskId }) => {
      try {
        const task = await client.completeTask(taskId);
        return refreshedDashboard(client, `Completed task "${task.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_task",
    {
      title: "Delete Jarvis task",
      description:
        "Use this only when the user explicitly asks to permanently remove a specific Jarvis task by ID.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: dashboardOutputSchema,
      annotations: destructiveAnnotations,
      _meta: dashboardMeta,
    },
    async ({ taskId }) => {
      try {
        const task = await client.deleteTask(taskId);
        return refreshedDashboard(client, `Deleted task "${task.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_reminders",
    {
      title: "List Jarvis reminders",
      description: "Use this when the user asks to see durable Jarvis reminders.",
      inputSchema: {},
      outputSchema: {
        reminders: z.array(reminderSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: {
        ui: { resourceUri: JARVIS_DASHBOARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": JARVIS_DASHBOARD_URI,
      },
    },
    async () => {
      try {
        const reminders = await client.listReminders();
        return {
          content: [{ type: "text" as const, text: `Found ${reminders.length} Jarvis reminders.` }],
          structuredContent: { reminders, count: reminders.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_reminder",
    {
      title: "Get Jarvis reminder",
      description: "Use this when the user asks for one Jarvis reminder by ID.",
      inputSchema: { reminderId: z.string().min(1) },
      outputSchema: { reminder: reminderSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ reminderId }) => {
      try {
        const reminder = await client.getReminder(reminderId);
        return reminderResult(reminder, `Reminder: ${reminder.title}`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  const dueSchema = z.object({
    text: z.string().trim().min(1).max(500),
    timezone: z.string().trim().min(1).max(500).optional(),
  });

  registerAppTool(
    server,
    "create_reminder",
    {
      title: "Create Jarvis reminder",
      description: "Use this when the user explicitly asks to add a durable Jarvis reminder.",
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        due: dueSchema.optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: createAnnotations,
      _meta: dashboardMeta,
    },
    async ({ title, due }) => {
      try {
        const reminder = await client.createReminder(title, due);
        return refreshedDashboard(client, `Created reminder "${reminder.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_reminder",
    {
      title: "Update Jarvis reminder",
      description:
        "Use this when the user explicitly asks to change a reminder title, due value, or clear its due value.",
      inputSchema: {
        reminderId: z.string().min(1),
        title: z.string().trim().min(1).max(500).optional(),
        due: dueSchema.nullable().optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: writeAnnotations,
      _meta: dashboardMeta,
    },
    async ({ reminderId, title, due }) => {
      try {
        if (title === undefined && due === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Reminder update requires a title or due change.",
              },
            ],
          };
        }
        const update: ReminderRequestUpdate = {
          ...(title === undefined ? {} : { title }),
          ...(due === undefined ? {} : { due }),
        };
        const reminder = await client.updateReminder(reminderId, update);
        return refreshedDashboard(client, `Updated reminder "${reminder.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_reminder",
    {
      title: "Delete Jarvis reminder",
      description:
        "Use this only when the user explicitly asks to permanently remove a specific Jarvis reminder by ID.",
      inputSchema: { reminderId: z.string().min(1) },
      outputSchema: dashboardOutputSchema,
      annotations: destructiveAnnotations,
      _meta: dashboardMeta,
    },
    async ({ reminderId }) => {
      try {
        const reminder = await client.deleteReminder(reminderId);
        return refreshedDashboard(client, `Deleted reminder "${reminder.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_clients",
    {
      title: "List business clients",
      description: "Use this when Benny wants to see or review his business clients.",
      inputSchema: {},
      outputSchema: { clients: z.array(clientSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const clients = await client.listClients();
        return {
          content: [{ type: "text" as const, text: `Found ${clients.length} clients.` }],
          structuredContent: { clients, count: clients.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_client",
    {
      title: "Get a business client",
      description: "Use this when the user refers to one known client by its identifier.",
      inputSchema: { clientId: z.string().min(1) },
      outputSchema: { client: clientSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ clientId }) => {
      try {
        return clientResult(await client.getClient(clientId), "Client details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_client",
    {
      title: "Create a business client",
      description: "Use this when the user explicitly asks to add a business client.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        contacts: z
          .array(
            z.object({
              label: z.string().trim().min(1).optional(),
              value: z.string().trim().min(1),
            }),
          )
          .optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      },
      outputSchema: { client: clientSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ name, contacts, notes }) => {
      try {
        const created = await client.createClient({
          name,
          ...(contacts === undefined ? {} : { contacts }),
          ...(notes === undefined ? {} : { notes }),
        });
        return clientResult(created, `Created client "${created.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_client",
    {
      title: "Update a business client",
      description:
        "Use this when the user explicitly asks to change a client's name, contacts, or notes.",
      inputSchema: {
        clientId: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        contacts: z
          .array(
            z.object({
              label: z.string().trim().min(1).optional(),
              value: z.string().trim().min(1),
            }),
          )
          .optional(),
        notes: z.string().trim().min(1).max(2000).nullable().optional(),
      },
      outputSchema: { client: clientSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ clientId, name, contacts, notes }) => {
      try {
        if (name === undefined && contacts === undefined && notes === undefined) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Client update requires a name, contacts, or notes." },
            ],
          };
        }
        const updated = await client.updateClient(clientId, {
          ...(name === undefined ? {} : { name }),
          ...(contacts === undefined ? {} : { contacts }),
          ...(notes === undefined ? {} : { notes }),
        });
        return clientResult(updated, `Updated client "${updated.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_client",
    {
      title: "Delete a business client",
      description:
        "Use this only when the user explicitly asks to permanently remove a client by identifier.",
      inputSchema: { clientId: z.string().min(1) },
      outputSchema: { client: clientSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ clientId }) => {
      try {
        const removed = await client.deleteClient(clientId);
        return clientResult(removed, `Deleted client "${removed.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_projects",
    {
      title: "List business projects",
      description: "Use this when Benny wants to see or review his projects (jobs).",
      inputSchema: {},
      outputSchema: { projects: z.array(projectSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const projects = await client.listProjects();
        return {
          content: [{ type: "text" as const, text: `Found ${projects.length} projects.` }],
          structuredContent: { projects, count: projects.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_project",
    {
      title: "Get a business project",
      description: "Use this when the user refers to one known project by its identifier.",
      inputSchema: { projectId: z.string().min(1) },
      outputSchema: { project: projectSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId }) => {
      try {
        return projectResult(await client.getProject(projectId), "Project details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_project",
    {
      title: "Create a business project",
      description: "Use this when the user explicitly asks to add a project (job) for a client.",
      inputSchema: {
        clientId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        status: z.enum(["lead", "quoted", "active", "on_hold", "done"]).optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      },
      outputSchema: { project: projectSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ clientId, title, status, notes }) => {
      try {
        const created = await client.createProject({
          clientId,
          title,
          ...(status === undefined ? {} : { status }),
          ...(notes === undefined ? {} : { notes }),
        });
        return projectResult(created, `Created project "${created.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_project",
    {
      title: "Update a business project",
      description:
        "Use this when the user explicitly asks to change a project's client, title, status, or notes.",
      inputSchema: {
        projectId: z.string().min(1),
        clientId: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["lead", "quoted", "active", "on_hold", "done"]).optional(),
        notes: z.string().trim().min(1).max(2000).nullable().optional(),
      },
      outputSchema: { project: projectSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId, clientId, title, status, notes }) => {
      try {
        if (
          clientId === undefined &&
          title === undefined &&
          status === undefined &&
          notes === undefined
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Project update requires a client, title, status, or notes.",
              },
            ],
          };
        }
        const updated = await client.updateProject(projectId, {
          ...(clientId === undefined ? {} : { clientId }),
          ...(title === undefined ? {} : { title }),
          ...(status === undefined ? {} : { status }),
          ...(notes === undefined ? {} : { notes }),
        });
        return projectResult(updated, `Updated project "${updated.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_project",
    {
      title: "Delete a business project",
      description:
        "Use this only when the user explicitly asks to permanently remove a project by identifier.",
      inputSchema: { projectId: z.string().min(1) },
      outputSchema: { project: projectSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId }) => {
      try {
        const removed = await client.deleteProject(projectId);
        return projectResult(removed, `Deleted project "${removed.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_quotes",
    {
      title: "List quotes",
      description:
        "Use this when Benny wants to inspect the current quote register without changing lifecycle state.",
      inputSchema: {},
      outputSchema: {
        quotes: z.array(quoteSummarySchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const quotes = await client.listQuotes();
        return {
          content: [{ type: "text" as const, text: `Found ${quotes.length} quotes.` }],
          structuredContent: { quotes, count: quotes.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_quote",
    {
      title: "Inspect a quote",
      description:
        "Use this when the user or Jarvis dashboard asks to inspect one known quote by identifier. This tool is read-only and cannot finalise, send, edit or record an outcome.",
      inputSchema: { quoteId: z.string().min(1) },
      outputSchema: { quote: quoteSnapshotSchema },
      annotations: readAnnotations,
      _meta: {
        ui: { resourceUri: JARVIS_DASHBOARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": JARVIS_DASHBOARD_URI,
      },
    },
    async ({ quoteId }) => {
      try {
        const quote: QuoteSnapshot = await client.getQuote(quoteId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Quote #${quote.aggregate.number}, revision ${quote.revision.revision}.`,
            },
          ],
          structuredContent: { quote },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_tool_actions",
    {
      title: "List tool-action proposals",
      description:
        "Use this to inspect the governed proposal/approval register for one project — including consent-lifecycle state (approved, expired, revoked) and exact approval expiry. This tool is strictly read-only: it cannot propose, approve, revoke, reject, or execute anything.",
      inputSchema: {
        projectId: z.string().min(1),
        state: z.enum(["proposed", "approved", "rejected", "expired", "revoked"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        actions: z.array(toolActionSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId }) => {
      try {
        const actions: ToolAction[] = await client.listToolActions(projectId);
        return {
          content: [
            { type: "text" as const, text: `Found ${actions.length} tool-action proposals.` },
          ],
          structuredContent: { actions, count: actions.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_tool_action",
    {
      title: "Inspect a tool-action proposal",
      description:
        "Use this to inspect one proposal's exact consent-lifecycle state — approval timestamp, exact expiry, revocation reason, or consumption policy. This tool is read-only and cannot approve, revoke, reject, or execute the action.",
      inputSchema: { projectId: z.string().min(1), actionId: z.string().min(1) },
      outputSchema: { action: toolActionSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId, actionId }) => {
      try {
        const action: ToolAction = await client.getToolAction(projectId, actionId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool action ${action.actionId}: ${action.tool}:${action.operation}, state ${action.state}.`,
            },
          ],
          structuredContent: { action },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  const receiptInspectionSchema = z.object({
    receiptId: z.string(),
    actionId: z.string(),
    projectId: z.string(),
    idempotencyKey: z.string(),
    executionMode: z.enum(["live", "dry-run"]),
    tool: z.string(),
    operation: z.string(),
    status: z.enum(["dry-run", "succeeded", "failed", "indeterminate", "blocked"]),
    errorCode: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string(),
  });

  registerAppTool(
    server,
    "list_tool_action_receipts",
    {
      title: "Inspect tool-action execution receipts",
      description:
        "Read-only inspection of durable execution receipts for one proposal. Live and dry-run receipts are distinct. A successful dry-run is never evidence that live execution occurred. This tool cannot approve, reject, revoke, or execute.",
      inputSchema: { projectId: z.string().min(1), actionId: z.string().min(1) },
      outputSchema: {
        receipts: z.array(receiptInspectionSchema),
        count: z.number().int().nonnegative(),
        liveReceipt: receiptInspectionSchema.nullable(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ projectId, actionId }) => {
      try {
        const result = await client.listToolActionReceipts(projectId, actionId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${result.receipts.length} execution receipt(s) for ${actionId}. Live receipt ${result.liveReceipt ? "present" : "absent"}.`,
            },
          ],
          structuredContent: {
            receipts: result.receipts,
            count: result.receipts.length,
            liveReceipt: result.liveReceipt,
          },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_daily_brief",
    {
      title: "Get the daily brief",
      description:
        "Use this when Benny asks what's on today, wants a morning summary, or asks what matters right now. Digests open tasks, due reminders, active projects, and outstanding quotes from the live stores.",
      inputSchema: {},
      outputSchema: { brief: briefSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const brief = await client.getDailyBrief();
        return {
          content: [{ type: "text" as const, text: brief.headline }],
          structuredContent: { brief },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_operations_inbox",
    {
      title: "Get the operations inbox",
      description:
        "Use this when Benny asks what needs his attention right now, or what's urgent. Read-only, owner-scoped digest of overdue reminders and overdue/due-soon maintenance, each backed by real records. Cannot dismiss, acknowledge, resolve, approve, revoke, or execute anything — inspection only. Sources not yet wired (governed tool-action approvals, reconciliation escalations, quote-delivery problems) are reported as unsupported, never silently empty.",
      inputSchema: {},
      outputSchema: { inbox: operationsInboxSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const inbox = await client.getOperationsInbox();
        return {
          content: [
            {
              type: "text" as const,
              text: `${inbox.items.length} item${inbox.items.length === 1 ? "" : "s"} in the operations inbox.`,
            },
          ],
          structuredContent: { inbox },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_activity",
    {
      title: "List recent operations activity",
      description:
        "Use this when Benny asks what's happened recently, or wants a history of governed-action and memory-change-set decisions. Bounded, cursor-paginated, owner-wide feed of durable audit events, newest first. Each entry's summary is built only from a fixed, known-safe subset of its fields — never raw event data. Read-only: nothing is mutated, and a read failure or unconfigured deployment is reported as unavailable rather than an empty page.",
      inputSchema: {
        cursor: z.string().optional().describe("Opaque pagination cursor from a previous page."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum events to return (default 50)."),
      },
      outputSchema: { activity: activityTimelineResultSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ cursor, limit }) => {
      try {
        const activity = await client.getOperationsActivity({ cursor, limit });
        const summary =
          activity.status === "available"
            ? `${activity.events.length} activity event${activity.events.length === 1 ? "" : "s"}.`
            : `Activity timeline unavailable: ${activity.reason}`;
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: { activity },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_errands",
    {
      title: "List errands",
      description:
        "Use this when Benny asks what he needs to pick up or do while out, or mentions being at or near a shop — check the open errands and their stored locations.",
      inputSchema: {},
      outputSchema: { errands: z.array(errandSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const errands = await client.listErrands();
        return {
          content: [{ type: "text" as const, text: `Found ${errands.length} errands.` }],
          structuredContent: { errands, count: errands.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_errand",
    {
      title: "Get an errand",
      description: "Use this when the user refers to one known errand by its identifier.",
      inputSchema: { errandId: z.string().min(1) },
      outputSchema: { errand: errandSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ errandId }) => {
      try {
        return errandResult(await client.getErrand(errandId), "Errand details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_errand",
    {
      title: "Create an errand",
      description:
        "Use this when Benny mentions something to pick up or do while out (e.g. milk, silicone x2 at Bunnings). If a place is known, resolve it with maps tooling first and pass the structured location — the server only stores it and never geocodes.",
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        quantity: z.number().positive().optional(),
        status: z.enum(["open", "done"]).optional(),
        location: errandLocationInputSchema.optional(),
        projectId: z.string().trim().min(1).max(200).optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      },
      outputSchema: { errand: errandSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ title, quantity, status, location, projectId, notes }) => {
      try {
        const created = await client.createErrand({
          title,
          ...(quantity === undefined ? {} : { quantity }),
          ...(status === undefined ? {} : { status }),
          ...(location === undefined ? {} : { location }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(notes === undefined ? {} : { notes }),
        });
        return errandResult(created, `Created errand "${created.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_errand",
    {
      title: "Update an errand",
      description:
        'Use this when the user explicitly asks to change an errand, or has picked something up — status "done" marks it complete and stamps the completion time.',
      inputSchema: {
        errandId: z.string().min(1),
        title: z.string().trim().min(1).max(500).optional(),
        quantity: z.number().positive().nullable().optional(),
        status: z.enum(["open", "done"]).optional(),
        location: errandLocationInputSchema.nullable().optional(),
        projectId: z.string().trim().min(1).max(200).nullable().optional(),
        notes: z.string().trim().min(1).max(2000).nullable().optional(),
      },
      outputSchema: { errand: errandSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ errandId, title, quantity, status, location, projectId, notes }) => {
      try {
        if (
          title === undefined &&
          quantity === undefined &&
          status === undefined &&
          location === undefined &&
          projectId === undefined &&
          notes === undefined
        ) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Errand update requires at least one changed field." },
            ],
          };
        }
        const updated = await client.updateErrand(errandId, {
          ...(title === undefined ? {} : { title }),
          ...(quantity === undefined ? {} : { quantity }),
          ...(status === undefined ? {} : { status }),
          ...(location === undefined ? {} : { location }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(notes === undefined ? {} : { notes }),
        });
        return errandResult(updated, `Updated errand "${updated.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_errand",
    {
      title: "Delete an errand",
      description:
        "Use this only when the user explicitly asks to permanently remove an errand by identifier.",
      inputSchema: { errandId: z.string().min(1) },
      outputSchema: { errand: errandSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ errandId }) => {
      try {
        const removed = await client.deleteErrand(errandId);
        return errandResult(removed, `Deleted errand "${removed.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_builds",
    {
      title: "List builds",
      description:
        "Use this when Benny wants to see or review his builds and machines — the RC crawler, the trailer, his tools.",
      inputSchema: {},
      outputSchema: { builds: z.array(buildSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const builds = await client.listBuilds();
        return {
          content: [{ type: "text" as const, text: `Found ${builds.length} builds.` }],
          structuredContent: { builds, count: builds.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_build",
    {
      title: "Get a build",
      description: "Use this when the user refers to one known build by its identifier.",
      inputSchema: { buildId: z.string().min(1) },
      outputSchema: { build: buildSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ buildId }) => {
      try {
        return buildResult(await client.getBuild(buildId), "Build details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_build",
    {
      title: "Create a build",
      description:
        "Use this when Benny starts or mentions a machine or project worth tracking (his RC crawler, the trailer, a tool).",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        kind: z.string().trim().min(1).max(100),
        status: z.enum(["planning", "active", "shelved", "retired"]).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        nickname: z.string().trim().min(1).max(100).optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      },
      outputSchema: { build: buildSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ name, kind, status, description, nickname, notes }) => {
      try {
        const created = await client.createBuild({
          name,
          kind,
          ...(status === undefined ? {} : { status }),
          ...(description === undefined ? {} : { description }),
          ...(nickname === undefined ? {} : { nickname }),
          ...(notes === undefined ? {} : { notes }),
        });
        return buildResult(created, `Created build "${created.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_build",
    {
      title: "Update a build",
      description:
        "Use this when the user explicitly asks to change a build's name, kind, status, description, nickname, or notes.",
      inputSchema: {
        buildId: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        kind: z.string().trim().min(1).max(100).optional(),
        status: z.enum(["planning", "active", "shelved", "retired"]).optional(),
        description: z.string().trim().min(1).max(2000).nullable().optional(),
        nickname: z.string().trim().min(1).max(100).nullable().optional(),
        notes: z.string().trim().min(1).max(2000).nullable().optional(),
      },
      outputSchema: { build: buildSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ buildId, name, kind, status, description, nickname, notes }) => {
      try {
        if (
          name === undefined &&
          kind === undefined &&
          status === undefined &&
          description === undefined &&
          nickname === undefined &&
          notes === undefined
        ) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Build update requires at least one changed field." },
            ],
          };
        }
        const updated = await client.updateBuild(buildId, {
          ...(name === undefined ? {} : { name }),
          ...(kind === undefined ? {} : { kind }),
          ...(status === undefined ? {} : { status }),
          ...(description === undefined ? {} : { description }),
          ...(nickname === undefined ? {} : { nickname }),
          ...(notes === undefined ? {} : { notes }),
        });
        return buildResult(updated, `Updated build "${updated.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_build",
    {
      title: "Delete a build",
      description:
        "Use this only when the user explicitly asks to permanently remove a build by identifier.",
      inputSchema: { buildId: z.string().min(1) },
      outputSchema: { build: buildSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ buildId }) => {
      try {
        const removed = await client.deleteBuild(buildId);
        return buildResult(removed, `Deleted build "${removed.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_build_log",
    {
      title: "List build log entries",
      description:
        "Use this when Benny wants the story of a build — its origins, milestones, failures, anecdotes, and notes across all builds.",
      inputSchema: {},
      outputSchema: {
        entries: z.array(buildLogSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const entries = await client.listBuildLogs();
        return {
          content: [{ type: "text" as const, text: `Found ${entries.length} build log entries.` }],
          structuredContent: { entries, count: entries.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_build_log",
    {
      title: "Get a build log entry",
      description: "Use this when the user refers to one known build log entry by its identifier.",
      inputSchema: { entryId: z.string().min(1) },
      outputSchema: { entry: buildLogSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ entryId }) => {
      try {
        return buildLogResult(await client.getBuildLog(entryId), "Build log entry.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_build_log",
    {
      title: "Record a build log entry",
      description:
        "Use this when Benny recounts something worth remembering about a build — why it started, a milestone reached, a failure, an anecdote, or a loose note. Attach it to the build by its identifier.",
      inputSchema: {
        buildId: z.string().trim().min(1).max(200),
        kind: z.enum(["origin", "milestone", "failure", "anecdote", "note"]).optional(),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(4000).optional(),
        occurredAt: z.number().optional(),
      },
      outputSchema: { entry: buildLogSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ buildId, kind, title, body, occurredAt }) => {
      try {
        const created = await client.createBuildLog({
          buildId,
          title,
          ...(kind === undefined ? {} : { kind }),
          ...(body === undefined ? {} : { body }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        });
        return buildLogResult(created, `Recorded build log entry "${created.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_build_log",
    {
      title: "Update a build log entry",
      description:
        "Use this when the user explicitly asks to change a build log entry's build, kind, title, body, or occurred time.",
      inputSchema: {
        entryId: z.string().min(1),
        buildId: z.string().trim().min(1).max(200).optional(),
        kind: z.enum(["origin", "milestone", "failure", "anecdote", "note"]).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().trim().min(1).max(4000).nullable().optional(),
        occurredAt: z.number().nullable().optional(),
      },
      outputSchema: { entry: buildLogSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ entryId, buildId, kind, title, body, occurredAt }) => {
      try {
        if (
          buildId === undefined &&
          kind === undefined &&
          title === undefined &&
          body === undefined &&
          occurredAt === undefined
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Build log update requires at least one changed field.",
              },
            ],
          };
        }
        const updated = await client.updateBuildLog(entryId, {
          ...(buildId === undefined ? {} : { buildId }),
          ...(kind === undefined ? {} : { kind }),
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        });
        return buildLogResult(updated, `Updated build log entry "${updated.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_build_log",
    {
      title: "Delete a build log entry",
      description:
        "Use this only when the user explicitly asks to permanently remove a build log entry by identifier.",
      inputSchema: { entryId: z.string().min(1) },
      outputSchema: { entry: buildLogSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ entryId }) => {
      try {
        const removed = await client.deleteBuildLog(entryId);
        return buildLogResult(removed, `Deleted build log entry "${removed.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_upgrade",
    {
      title: "List upgrades",
      description:
        "Use this when Benny wants the upgrade chronicle — the changes made to his builds over time, across all builds.",
      inputSchema: {},
      outputSchema: {
        upgrades: z.array(upgradeSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const upgrades = await client.listUpgrades();
        return {
          content: [{ type: "text" as const, text: `Found ${upgrades.length} upgrades.` }],
          structuredContent: { upgrades, count: upgrades.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_upgrade",
    {
      title: "Get an upgrade",
      description: "Use this when the user refers to one known upgrade by its identifier.",
      inputSchema: { upgradeId: z.string().min(1) },
      outputSchema: { upgrade: upgradeSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ upgradeId }) => {
      try {
        return upgradeResult(await client.getUpgrade(upgradeId), "Upgrade details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_upgrade",
    {
      title: "Record an upgrade",
      description:
        "Use this when Benny changes something on a build worth remembering — a swap or modification. Attach it to the build by its identifier; capture why, the before/after, the outcome, and the parts involved.",
      inputSchema: {
        buildId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(4000).optional(),
        beforeState: z.string().trim().min(1).max(4000).optional(),
        afterState: z.string().trim().min(1).max(4000).optional(),
        outcome: z.string().trim().min(1).max(4000).optional(),
        parts: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
        version: z.string().trim().min(1).max(100).optional(),
        occurredAt: z.number().optional(),
      },
      outputSchema: { upgrade: upgradeSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({
      buildId,
      title,
      reason,
      beforeState,
      afterState,
      outcome,
      parts,
      version,
      occurredAt,
    }) => {
      try {
        const created = await client.createUpgrade({
          buildId,
          title,
          ...(reason === undefined ? {} : { reason }),
          ...(beforeState === undefined ? {} : { beforeState }),
          ...(afterState === undefined ? {} : { afterState }),
          ...(outcome === undefined ? {} : { outcome }),
          ...(parts === undefined ? {} : { parts }),
          ...(version === undefined ? {} : { version }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        });
        return upgradeResult(created, `Recorded upgrade "${created.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_upgrade",
    {
      title: "Update an upgrade",
      description:
        "Use this when the user explicitly asks to change an upgrade's build, title, reason, before/after state, outcome, parts, version, or occurred time.",
      inputSchema: {
        upgradeId: z.string().min(1),
        buildId: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        reason: z.string().trim().min(1).max(4000).nullable().optional(),
        beforeState: z.string().trim().min(1).max(4000).nullable().optional(),
        afterState: z.string().trim().min(1).max(4000).nullable().optional(),
        outcome: z.string().trim().min(1).max(4000).nullable().optional(),
        parts: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
        version: z.string().trim().min(1).max(100).nullable().optional(),
        occurredAt: z.number().nullable().optional(),
      },
      outputSchema: { upgrade: upgradeSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({
      upgradeId,
      buildId,
      title,
      reason,
      beforeState,
      afterState,
      outcome,
      parts,
      version,
      occurredAt,
    }) => {
      try {
        if (
          buildId === undefined &&
          title === undefined &&
          reason === undefined &&
          beforeState === undefined &&
          afterState === undefined &&
          outcome === undefined &&
          parts === undefined &&
          version === undefined &&
          occurredAt === undefined
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Upgrade update requires at least one changed field.",
              },
            ],
          };
        }
        const updated = await client.updateUpgrade(upgradeId, {
          ...(buildId === undefined ? {} : { buildId }),
          ...(title === undefined ? {} : { title }),
          ...(reason === undefined ? {} : { reason }),
          ...(beforeState === undefined ? {} : { beforeState }),
          ...(afterState === undefined ? {} : { afterState }),
          ...(outcome === undefined ? {} : { outcome }),
          ...(parts === undefined ? {} : { parts }),
          ...(version === undefined ? {} : { version }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        });
        return upgradeResult(updated, `Updated upgrade "${updated.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_upgrade",
    {
      title: "Delete an upgrade",
      description:
        "Use this only when the user explicitly asks to permanently remove an upgrade by identifier.",
      inputSchema: { upgradeId: z.string().min(1) },
      outputSchema: { upgrade: upgradeSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ upgradeId }) => {
      try {
        const removed = await client.deleteUpgrade(upgradeId);
        return upgradeResult(removed, `Deleted upgrade "${removed.title}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_asset",
    {
      title: "List assets",
      description:
        "Use this when Benny wants to see his tools and machines and their maintenance status — what's due or coming due for a service.",
      inputSchema: {},
      outputSchema: {
        assets: z.array(assetSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const assets = await client.listAssets();
        const dueCount = assets.filter((asset) => asset.due).length;
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${assets.length} assets${dueCount > 0 ? `, ${dueCount} due for service` : ""}.`,
            },
          ],
          structuredContent: { assets, count: assets.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_asset",
    {
      title: "Get an asset",
      description: "Use this when the user refers to one known asset by its identifier.",
      inputSchema: { assetId: z.string().min(1) },
      outputSchema: { asset: assetSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ assetId }) => {
      try {
        return assetResult(await client.getAsset(assetId), "Asset details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_asset",
    {
      title: "Create an asset",
      description:
        "Use this when Benny wants to track a tool or machine for servicing. An optional service interval (in days) and last-serviced date let Jarvis work out when the next service is due.",
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        kind: z.string().trim().min(1).max(100),
        serviceIntervalDays: z.number().int().positive().optional(),
        lastServicedAt: z.number().optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      },
      outputSchema: { asset: assetSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ name, kind, serviceIntervalDays, lastServicedAt, notes }) => {
      try {
        const created = await client.createAsset({
          name,
          kind,
          ...(serviceIntervalDays === undefined ? {} : { serviceIntervalDays }),
          ...(lastServicedAt === undefined ? {} : { lastServicedAt }),
          ...(notes === undefined ? {} : { notes }),
        });
        return assetResult(created, `Created asset "${created.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_asset",
    {
      title: "Update an asset",
      description:
        "Use this when the user explicitly asks to change an asset's name, kind, service interval, last-serviced date, or notes — for example after servicing it.",
      inputSchema: {
        assetId: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        kind: z.string().trim().min(1).max(100).optional(),
        serviceIntervalDays: z.number().int().positive().nullable().optional(),
        lastServicedAt: z.number().nullable().optional(),
        notes: z.string().trim().min(1).max(2000).nullable().optional(),
      },
      outputSchema: { asset: assetSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ assetId, name, kind, serviceIntervalDays, lastServicedAt, notes }) => {
      try {
        if (
          name === undefined &&
          kind === undefined &&
          serviceIntervalDays === undefined &&
          lastServicedAt === undefined &&
          notes === undefined
        ) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Asset update requires at least one changed field." },
            ],
          };
        }
        const updated = await client.updateAsset(assetId, {
          ...(name === undefined ? {} : { name }),
          ...(kind === undefined ? {} : { kind }),
          ...(serviceIntervalDays === undefined ? {} : { serviceIntervalDays }),
          ...(lastServicedAt === undefined ? {} : { lastServicedAt }),
          ...(notes === undefined ? {} : { notes }),
        });
        return assetResult(updated, `Updated asset "${updated.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_asset",
    {
      title: "Delete an asset",
      description:
        "Use this only when the user explicitly asks to permanently remove an asset by identifier.",
      inputSchema: { assetId: z.string().min(1) },
      outputSchema: { asset: assetSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ assetId }) => {
      try {
        const removed = await client.deleteAsset(assetId);
        return assetResult(removed, `Deleted asset "${removed.name}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_preference",
    {
      title: "List preferences",
      description:
        "Use this when Benny wants to see his standing choices — brands, tools, naming, defaults — or when you need to check how he likes something done.",
      inputSchema: {},
      outputSchema: {
        preferences: z.array(preferenceSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      try {
        const preferences = await client.listPreferences();
        return {
          content: [{ type: "text" as const, text: `Found ${preferences.length} preferences.` }],
          structuredContent: { preferences, count: preferences.length },
        };
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_preference",
    {
      title: "Get a preference",
      description: "Use this when the user refers to one known preference by its identifier.",
      inputSchema: { preferenceId: z.string().min(1) },
      outputSchema: { preference: preferenceSchema },
      annotations: readAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ preferenceId }) => {
      try {
        return preferenceResult(await client.getPreference(preferenceId), "Preference details.");
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_preference",
    {
      title: "Record a preference",
      description:
        "Use this when Benny states a standing choice worth remembering — a brand he favours, a tool he reaches for, a naming convention, a default. Store it as a key and value, with an optional category to group related ones.",
      inputSchema: {
        key: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1).max(2000),
        category: z.string().trim().min(1).max(100).optional(),
      },
      outputSchema: { preference: preferenceSchema },
      annotations: createAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ key, value, category }) => {
      try {
        const created = await client.createPreference({
          key,
          value,
          ...(category === undefined ? {} : { category }),
        });
        return preferenceResult(created, `Recorded preference "${created.key}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_preference",
    {
      title: "Update a preference",
      description:
        "Use this when the user explicitly asks to change a preference's key, value, or category.",
      inputSchema: {
        preferenceId: z.string().min(1),
        key: z.string().trim().min(1).max(200).optional(),
        value: z.string().trim().min(1).max(2000).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
      },
      outputSchema: { preference: preferenceSchema },
      annotations: writeAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ preferenceId, key, value, category }) => {
      try {
        if (key === undefined && value === undefined && category === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Preference update requires at least one changed field.",
              },
            ],
          };
        }
        const updated = await client.updatePreference(preferenceId, {
          ...(key === undefined ? {} : { key }),
          ...(value === undefined ? {} : { value }),
          ...(category === undefined ? {} : { category }),
        });
        return preferenceResult(updated, `Updated preference "${updated.key}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_preference",
    {
      title: "Delete a preference",
      description:
        "Use this only when the user explicitly asks to permanently remove a preference by identifier.",
      inputSchema: { preferenceId: z.string().min(1) },
      outputSchema: { preference: preferenceSchema },
      annotations: destructiveAnnotations,
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ preferenceId }) => {
      try {
        const removed = await client.deletePreference(preferenceId);
        return preferenceResult(removed, `Deleted preference "${removed.key}".`);
      } catch (error: unknown) {
        return safeError(error);
      }
    },
  );

  return server;
}
