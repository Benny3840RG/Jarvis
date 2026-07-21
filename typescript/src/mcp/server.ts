import { readFileSync } from "node:fs";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Client } from "../clients/client.js";
import type { Project } from "../projects/project.js";
import type { Reminder, Task } from "../persistence/persistence.js";
import {
  JarvisApiClient,
  JarvisApiError,
  type DashboardSnapshot,
  type ReminderRequestUpdate,
} from "./jarvisApiClient.js";

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

const dashboardOutputSchema = {
  status: statusSchema,
  tasks: z.array(taskSchema),
  reminders: z.array(reminderSchema),
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
  const server = new McpServer({
    name: "jarvis-private-preview",
    version: "0.1.0",
  });

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

  return server;
}
