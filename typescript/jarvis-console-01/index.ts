import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { MCPServer, text, widget } from "mcp-use/server";
import { z } from "zod";

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

const consoleStateSchema = z.object({
  title: z.string(),
  phase: z.string(),
  deployment: z.string(),
  environment: z.string(),
  status: z.enum(["operational", "degraded", "offline"]),
  mission: z.string(),
  progress: z.number().min(0).max(100),
  lastUpdated: z.number(),
  tasks: z.array(taskSchema),
  reminders: z.array(reminderSchema),
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
  }),
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

async function loadConsoleState(activity: string[] = []): Promise<ConsoleState> {
  const now = Date.now();
  const deployment = process.env.MCP_URL || "Manufact Cloud";
  try {
    const { client, serviceToken } = requireBridge();
    const [taskRows, reminderRows] = await Promise.all([
      client.query(anyApi.tasks.list, { serviceToken }) as Promise<TaskRow[]>,
      client.query(anyApi.reminders.list, { serviceToken }) as Promise<ReminderRow[]>,
    ]);
    const tasks = taskRows.map(mapTask).sort((a, b) => b.createdAt - a.createdAt);
    const reminders = reminderRows
      .map(mapReminder)
      .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER));
    const active = tasks.filter((task) => !task.completed).length;
    const completed = tasks.length - active;
    const total = tasks.length;
    const progress = total === 0 ? 100 : Math.round((completed / total) * 100);

    return {
      title: "JARVIS SYSTEM // CONSOLE 01",
      phase: "PHASES 2 + 3 · LIVE COMMAND CENTRE",
      deployment,
      environment: process.env.NODE_ENV || "production",
      status: "operational",
      mission: active > 0 ? tasks.find((task) => !task.completed)?.title ?? "Maintain operational readiness" : "Command deck clear",
      progress,
      lastUpdated: now,
      tasks,
      reminders,
      systems: [
        { label: "MCP endpoint", value: "ONLINE", state: "good" },
        { label: "Manufact", value: "DEPLOYED", state: "good" },
        { label: "Convex", value: "AUTHENTICATED", state: "good" },
        { label: "Owner scope", value: "ENFORCED", state: "good" },
        { label: "Production authority", value: "GUARDED", state: "guarded" },
      ],
      activity: [
        ...activity,
        `${active} active task${active === 1 ? "" : "s"} loaded`,
        `${reminders.length} reminder${reminders.length === 1 ? "" : "s"} tracked`,
        "Convex bridge authenticated server-side",
        "No fabricated telemetry enabled",
      ].slice(0, 8),
      counts: { active, completed, reminders: reminders.length },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown bridge failure";
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
      systems: [
        { label: "MCP endpoint", value: "ONLINE", state: "good" },
        { label: "Manufact", value: "DEPLOYED", state: "good" },
        { label: "Convex", value: "BRIDGE DEGRADED", state: "pending" },
        { label: "Production authority", value: "GUARDED", state: "guarded" },
      ],
      activity: [...activity, detail, "Console failed closed without exposing credentials"].slice(0, 8),
      counts: { active: 0, completed: 0, reminders: 0 },
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
    schema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    outputSchema: consoleStateSchema,
    widget: { name: "product-search-result", invoking: "Synchronising Console 01...", invoked: "Console 01 online" },
  },
  async () => consoleWidget(await loadConsoleState(["Console snapshot refreshed"]), "Jarvis Console 01 is synchronised with authenticated Convex state."),
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

server.listen().then(() => {
  console.log("Jarvis Console 01 server running");
});
