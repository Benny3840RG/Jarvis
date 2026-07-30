import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { MCPServer, text, widget } from "mcp-use/server";
import { z } from "zod";

import { decideGatewayAccess } from "./gatewayAuth.js";
import {
  bridgeFailureActivity,
  buildConsolePageSummary,
  consolePaginationInvariantIssues,
  DEFAULT_PAGE_SIZE,
  normaliseConsolePageRequest,
  type ConsolePage,
  type ConsolePageRequest,
} from "./pagination.js";

const server = new MCPServer({
  name: "jarvis-console-01",
  title: "Jarvis Console 01",
  version: "1.2.0",
  description: "Live Jarvis command centre backed by owner-scoped Convex state",
  instructions:
    "Use show-jarvis-console to open Console 01. Use the typed task and reminder tools for controlled changes. The service token remains server-side and production deployment is not authorised.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://github.com/Benny3840/Jarvis",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

// The Convex service token is a server-held secret used only for the Convex
// bridge; it is never presented by a caller, so it cannot double as a gateway
// credential. CONSOLE_GATEWAY_TOKEN is the separate, caller-presented secret
// that actually gates reaching the MCP surface at all.
const gatewayToken = process.env.CONSOLE_GATEWAY_TOKEN;

function parseBearerToken(header: string | null | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (\S+)$/i.exec(header);
  return match?.[1];
}

async function readJsonRpcMethod(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json")) return undefined;

  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const method = (body as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}

server.use(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isGatedRoute =
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path === "/sse" ||
    path.startsWith("/sse/");
  if (!isGatedRoute) return next();

  const rpcMethod = path === "/mcp" ? await readJsonRpcMethod(c.req.raw) : undefined;
  const decision = decideGatewayAccess({
    configuredToken: gatewayToken,
    candidateToken: parseBearerToken(c.req.header("authorization")),
    rpcMethod,
  });

  if (decision === "allow-initialize" || decision === "allow-token") return next();
  if (decision === "missing-configuration") {
    return c.json({ error: "Console gateway authentication is not configured." }, 503);
  }
  return c.json({ error: "A valid Bearer gateway token is required." }, 401);
});

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

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  domain: z.enum(["business", "home", "workshop", "shared"]),
  sensitivity: z.enum(["internal", "private", "secret"]),
  createdAt: z.number(),
});

const governedActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  operation: z.string(),
  state: z.enum(["proposed", "approved", "rejected", "expired", "revoked"]),
  rationale: z.string(),
  requiredAuthority: z.enum(["T0", "T1", "T2", "T3"]),
  destructive: z.boolean(),
  approvalExpiresAt: z.number().optional(),
  isApprovalExpired: z.boolean().optional(),
  revokedReason: z.string().optional(),
  createdAt: z.number(),
});

/**
 * Console 01 has no project-selection UI, unlike the rest of Jarvis where
 * notes (and governed tool-action proposals) are project-scoped. Every note
 * created or listed, and every governed action inspected, through the
 * console lives in this single fixed project namespace, kept separate from
 * whatever projects the rest of Jarvis manages.
 */
const NOTES_PROJECT_ID = "jarvis-console-01";

const paginationMetaSchema = z.object({
  isDone: z.boolean(),
  continueCursor: z.string(),
  returnedCount: z.number().int().nonnegative(),
  requestedPageSize: z.number().int().min(1).max(100),
});

const consoleStateSchema = z.object({
  title: z.string(),
  phase: z.string(),
  deployment: z.string(),
  environment: z.string(),
  status: z.enum(["operational", "degraded", "offline"]),
  mission: z.string(),
  progress: z.number().min(0).max(100),
  lastUpdated: z.number(),
  tasks: z.array(taskSchema).max(100),
  reminders: z.array(reminderSchema).max(100),
  notes: z.array(noteSchema).max(100),
  governedActions: z.array(governedActionSchema).max(100),
  systems: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      state: z.enum(["good", "guarded", "pending"]),
    }),
  ),
  activity: z.array(z.string()),
  counts: z.object({
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    reminders: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    tasksPartial: z.boolean(),
    remindersPartial: z.boolean(),
    notesPartial: z.boolean(),
  }),
  pagination: z.object({
    tasks: paginationMetaSchema,
    reminders: paginationMetaSchema,
    notes: paginationMetaSchema,
  }),
}).superRefine((value, ctx) => {
  for (const issue of consolePaginationInvariantIssues(value)) {
    ctx.addIssue({ code: "custom", ...issue });
  }
});

type TaskRow = {
  _id: string;
  title: string;
  completed: boolean;
  category: string;
  createdAt: number;
};

type ReminderRow = {
  _id: string;
  title: string;
  due?: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
};

type NoteRow = {
  _id: string;
  title: string;
  body: string;
  tags: string[];
  domain: "business" | "home" | "workshop" | "shared";
  sensitivity: "internal" | "private" | "secret";
  createdAt: number;
};

type ToolActionRow = {
  _id: string;
  tool: string;
  operation: string;
  state: "proposed" | "approved" | "rejected" | "expired" | "revoked";
  rationale: string;
  requiredAuthority: "T0" | "T1" | "T2" | "T3";
  destructive: boolean;
  approvalExpiresAt?: number;
  isApprovalExpired?: boolean;
  revokedReason?: string;
  createdAt: number;
};

type ConsoleState = z.infer<typeof consoleStateSchema>;

function requireBridge() {
  const convexUrl = process.env.CONVEX_URL;
  const serviceToken = process.env.JARVIS_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) {
    throw new Error("Console 01 requires CONVEX_URL and JARVIS_SERVICE_TOKEN on the server.");
  }
  return { client: new ConvexHttpClient(convexUrl), serviceToken };
}

function mapTask(row: TaskRow) {
  return {
    id: row._id,
    title: row.title,
    completed: row.completed,
    category: row.category,
    createdAt: row.createdAt,
  };
}

function mapReminder(row: ReminderRow) {
  const dueRaw = row.dueRaw ?? row.due;
  return {
    id: row._id,
    title: row.title,
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(row.dueAt === undefined ? {} : { dueAt: row.dueAt }),
    ...(row.dueTimezone === undefined ? {} : { dueTimezone: row.dueTimezone }),
    createdAt: row.createdAt,
  };
}

function mapNote(row: NoteRow) {
  return {
    id: row._id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    domain: row.domain,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt,
  };
}

/**
 * Read-only mapping. Console 01 exposes no way to propose, approve, revoke,
 * reject, or execute a governed action — only to inspect its consent-
 * lifecycle state (see docs/superpowers/plans/2026-07-30-tool-action-consent-lifecycle.md).
 */
function mapGovernedAction(row: ToolActionRow) {
  return {
    id: row._id,
    tool: row.tool,
    operation: row.operation,
    state: row.state,
    rationale: row.rationale,
    requiredAuthority: row.requiredAuthority,
    destructive: row.destructive,
    ...(row.approvalExpiresAt === undefined ? {} : { approvalExpiresAt: row.approvalExpiresAt }),
    ...(row.isApprovalExpired === undefined ? {} : { isApprovalExpired: row.isApprovalExpired }),
    ...(row.revokedReason === undefined ? {} : { revokedReason: row.revokedReason }),
    createdAt: row.createdAt,
  };
}

function emptyPageMetadata(requestedPageSize: number) {
  return { isDone: true, continueCursor: "", returnedCount: 0, requestedPageSize };
}

async function loadConsoleState(
  activity: string[] = [],
  pageRequest: ConsolePageRequest = {},
): Promise<ConsoleState> {
  const now = Date.now();
  const deployment = process.env.MCP_URL || "Manufact Cloud";
  let requestedPageSize = DEFAULT_PAGE_SIZE;
  try {
    const request = normaliseConsolePageRequest(pageRequest);
    requestedPageSize = request.pageSize;
    const { client, serviceToken } = requireBridge();
    const [taskPage, reminderPage, notePage, governedActionRows] = await Promise.all([
      client.query(anyApi.tasks.listPage, {
        serviceToken,
        paginationOpts: { numItems: request.pageSize, cursor: request.taskCursor },
      }) as Promise<ConsolePage<TaskRow>>,
      client.query(anyApi.reminders.listPage, {
        serviceToken,
        paginationOpts: { numItems: request.pageSize, cursor: request.reminderCursor },
      }) as Promise<ConsolePage<ReminderRow>>,
      client.query(anyApi.notes.listPage, {
        serviceToken,
        projectId: NOTES_PROJECT_ID,
        paginationOpts: { numItems: request.pageSize, cursor: request.noteCursor },
      }) as Promise<ConsolePage<NoteRow>>,
      // Read-only inspection: no cursor pagination exists for tool actions
      // yet, so this is a bounded recent-first snapshot, not a full register.
      client.query(anyApi.toolActions.listRecent, {
        serviceToken,
        projectKey: NOTES_PROJECT_ID,
        limit: request.pageSize,
      }) as Promise<ToolActionRow[]>,
    ]);
    const tasks = taskPage.page.map(mapTask);
    const reminders = reminderPage.page.map(mapReminder);
    const notes = notePage.page.map(mapNote);
    const governedActions = governedActionRows.map(mapGovernedAction);
    const summary = buildConsolePageSummary(taskPage, reminderPage, notePage, request.pageSize, {
      taskCursor: request.taskCursor,
      reminderCursor: request.reminderCursor,
      noteCursor: request.noteCursor,
    });
    const { active } = summary.counts;

    return {
      title: "JARVIS SYSTEM // CONSOLE 01",
      phase: "PHASES 2 + 3 · LIVE COMMAND CENTRE",
      deployment,
      environment: process.env.NODE_ENV || "production",
      status: "operational",
      mission:
        active > 0
          ? tasks.find((task) => !task.completed)?.title ?? "Maintain operational readiness"
          : summary.counts.tasksPartial
            ? "Continue task pagination for full state"
            : "Command deck clear",
      progress: summary.progress,
      lastUpdated: now,
      tasks,
      reminders,
      notes,
      governedActions,
      systems: [
        { label: "MCP endpoint", value: "ONLINE", state: "good" },
        { label: "Manufact", value: "DEPLOYED", state: "good" },
        { label: "Convex", value: "AUTHENTICATED", state: "good" },
        { label: "Owner scope", value: "ENFORCED", state: "good" },
        gatewayToken
          ? { label: "Gateway auth", value: "ENFORCED", state: "good" }
          : { label: "Gateway auth", value: "NOT CONFIGURED", state: "pending" },
      ],
      activity: [
        ...activity,
        `${active} visible active task${active === 1 ? "" : "s"} loaded`,
        `${reminders.length} visible reminder${reminders.length === 1 ? "" : "s"} tracked`,
        `${notes.length} visible note${notes.length === 1 ? "" : "s"} logged`,
        "Convex bridge authenticated server-side",
        "No fabricated telemetry enabled",
      ].slice(0, 8),
      counts: summary.counts,
      pagination: summary.pagination,
    };
  } catch {
    return {
      title: "JARVIS SYSTEM // CONSOLE 01",
      phase: "PHASES 2 + 3 · LIVE COMMAND CENTRE",
      deployment,
      environment: process.env.NODE_ENV || "production",
      status: "degraded",
      mission: "Restore the authenticated Convex bridge",
      progress: 0,
      lastUpdated: now,
      tasks: [],
      reminders: [],
      notes: [],
      governedActions: [],
      systems: [
        { label: "MCP endpoint", value: "ONLINE", state: "good" },
        { label: "Manufact", value: "DEPLOYED", state: "good" },
        { label: "Convex", value: "BRIDGE DEGRADED", state: "pending" },
        gatewayToken
          ? { label: "Gateway auth", value: "ENFORCED", state: "good" }
          : { label: "Gateway auth", value: "NOT CONFIGURED", state: "pending" },
      ],
      activity: bridgeFailureActivity(activity),
      counts: {
        active: 0,
        completed: 0,
        reminders: 0,
        notes: 0,
        tasksPartial: false,
        remindersPartial: false,
        notesPartial: false,
      },
      pagination: {
        tasks: emptyPageMetadata(requestedPageSize),
        reminders: emptyPageMetadata(requestedPageSize),
        notes: emptyPageMetadata(requestedPageSize),
      },
    };
  }
}

function consoleWidget(props: ConsoleState, message: string) {
  return widget({ props, output: text(message) });
}

server.tool(
  {
    name: "show-jarvis-console",
    title: "Open Jarvis Console 01",
    description: "Open the live Jarvis Console 01 command centre",
    schema: z.object({
      pageSize: z.number().int().min(1).max(100).optional(),
      taskCursor: z.string().optional(),
      reminderCursor: z.string().optional(),
      noteCursor: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Synchronising Console 01...", invoked: "Console 01 online" },
  },
  async (pageRequest) =>
    consoleWidget(
      await loadConsoleState(["Console snapshot refreshed"], pageRequest),
      "Jarvis Console 01 is synchronised with authenticated Convex state.",
    ),
);

server.tool(
  {
    name: "create-jarvis-task",
    title: "Create Jarvis task",
    description: "Create an owner-scoped durable Jarvis task",
    schema: z.object({
      title: z.string().min(1).max(500),
      category: z.enum(["personal", "work", "builds", "money", "life"]).default("personal"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Creating task...", invoked: "Task created" },
  },
  async ({ title, category }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.tasks.create, { serviceToken, title, category });
    return consoleWidget(await loadConsoleState([`Task created: ${title}`]), `Created Jarvis task: ${title}`);
  },
);

server.tool(
  {
    name: "complete-jarvis-task",
    title: "Complete Jarvis task",
    description: "Complete one owner-scoped durable Jarvis task",
    schema: z.object({ taskId: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Completing task...", invoked: "Task completed" },
  },
  async ({ taskId }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.tasks.complete, { serviceToken, id: taskId });
    return consoleWidget(await loadConsoleState(["Task completed through Console 01"]), "Jarvis task completed.");
  },
);

server.tool(
  {
    name: "create-jarvis-reminder",
    title: "Create Jarvis reminder",
    description: "Create an owner-scoped durable Jarvis reminder",
    schema: z.object({ title: z.string().min(1).max(500), dueRaw: z.string().max(500).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Setting reminder...", invoked: "Reminder set" },
  },
  async ({ title, dueRaw }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.reminders.create, {
      serviceToken,
      title,
      ...(dueRaw ? { dueRaw } : {}),
    });
    return consoleWidget(await loadConsoleState([`Reminder created: ${title}`]), `Created Jarvis reminder: ${title}`);
  },
);

server.tool(
  {
    name: "remove-jarvis-reminder",
    title: "Remove Jarvis reminder",
    description: "Remove one owner-scoped durable Jarvis reminder",
    schema: z.object({ reminderId: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Removing reminder...", invoked: "Reminder removed" },
  },
  async ({ reminderId }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.reminders.remove, { serviceToken, id: reminderId });
    return consoleWidget(await loadConsoleState(["Reminder removed through Console 01"]), "Jarvis reminder removed.");
  },
);

server.tool(
  {
    name: "create-jarvis-note",
    title: "Create Jarvis note",
    description: "Create an owner-scoped durable Jarvis note in the Console 01 project namespace",
    schema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      domain: z.enum(["business", "home", "workshop", "shared"]).default("home"),
      sensitivity: z.enum(["internal", "private", "secret"]).default("internal"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Creating note...", invoked: "Note created" },
  },
  async ({ title, body, tags, domain, sensitivity }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.notes.create, {
      serviceToken,
      projectId: NOTES_PROJECT_ID,
      title,
      body,
      tags: tags ?? [],
      domain,
      sensitivity,
      retention: "standard",
      idempotencyKey: randomUUID(),
      actionFingerprint: randomUUID(),
      sourceRequestId: randomUUID(),
      correlationId: randomUUID(),
      source: "jarvis-console-01",
    });
    return consoleWidget(await loadConsoleState([`Note created: ${title}`]), `Created Jarvis note: ${title}`);
  },
);

server.tool(
  {
    name: "remove-jarvis-note",
    title: "Remove Jarvis note",
    description: "Remove one owner-scoped durable Jarvis note from the Console 01 project namespace",
    schema: z.object({ noteId: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Removing note...", invoked: "Note removed" },
  },
  async ({ noteId }) => {
    const { client, serviceToken } = requireBridge();
    await client.mutation(anyApi.notes.remove, {
      serviceToken,
      projectId: NOTES_PROJECT_ID,
      id: noteId,
    });
    return consoleWidget(await loadConsoleState(["Note removed through Console 01"]), "Jarvis note removed.");
  },
);

server.listen().then(() => {
  console.log("Jarvis Console 01 server running");
});
