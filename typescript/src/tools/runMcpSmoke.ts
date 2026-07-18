import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { DashboardSnapshot } from "../mcp/jarvisApiClient.js";
import { JARVIS_DASHBOARD_URI } from "../mcp/server.js";

const REQUIRED_TOOLS = [
  "show_jarvis_dashboard",
  "get_jarvis_status",
  "list_tasks",
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "list_reminders",
  "create_reminder",
  "update_reminder",
  "delete_reminder",
] as const;

function requiredDevelopmentDeployment(value: string | undefined): string {
  const deployment = value?.trim();
  if (!deployment?.startsWith("dev:")) {
    throw new Error("MCP smoke test requires a Convex development deployment.");
  }
  return deployment;
}

function resolveMcpUrl(value: string | undefined): URL {
  const raw = value?.trim() || "http://127.0.0.1:8787/mcp";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("JARVIS_MCP_URL must use HTTP or HTTPS.");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join(" ")
    .trim();
}

function dashboardFrom(result: CallToolResult): DashboardSnapshot {
  if (result.isError) {
    throw new Error(resultText(result) || "Jarvis MCP tool returned an error.");
  }
  if (!isRecord(result.structuredContent)) {
    throw new Error("Jarvis MCP tool did not return dashboard structured content.");
  }
  return result.structuredContent as DashboardSnapshot;
}

async function callDashboardTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<DashboardSnapshot> {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result)) {
    throw new Error("Jarvis MCP tool unexpectedly returned an asynchronous task handle.");
  }
  return dashboardFrom(result);
}

async function cleanupTool(
  client: Client,
  name: "delete_task" | "delete_reminder",
  idField: "taskId" | "reminderId",
  id: string | null,
): Promise<void> {
  if (!id) return;
  try {
    await client.callTool({ name, arguments: { [idField]: id } });
  } catch {
    // The primary smoke failure remains authoritative; cleanup is best effort.
  }
}

async function main(): Promise<void> {
  const deployment = requiredDevelopmentDeployment(process.env.CONVEX_DEPLOYMENT);
  const mcpUrl = resolveMcpUrl(process.env.JARVIS_MCP_URL);
  const client = new Client({ name: "jarvis-development-mcp-smoke", version: "0.1.0" });
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const taskTitle = `MCP commissioning task ${suffix}`;
  const updatedTaskTitle = `${taskTitle} updated`;
  const reminderTitle = `MCP commissioning reminder ${suffix}`;
  const updatedReminderTitle = `${reminderTitle} updated`;
  let taskId: string | null = null;
  let reminderId: string | null = null;

  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));

    const toolList = await client.listTools();
    const toolNames = new Set(toolList.tools.map((tool) => tool.name));
    for (const tool of REQUIRED_TOOLS) {
      if (!toolNames.has(tool)) throw new Error(`Required MCP tool is missing: ${tool}`);
    }

    const resource = await client.readResource({ uri: JARVIS_DASHBOARD_URI });
    if (resource.contents.length !== 1) {
      throw new Error("Jarvis dashboard resource did not return exactly one document.");
    }
    const widget = resource.contents[0];
    if (!widget || widget.mimeType !== "text/html;profile=mcp-app" || !("text" in widget)) {
      throw new Error("Jarvis dashboard resource did not return the expected MCP app document.");
    }
    if (!widget.text.includes("JARVIS // OPERATOR CONSOLE")) {
      throw new Error("Jarvis dashboard resource did not contain the operator console marker.");
    }
    if (/JARVIS_SERVICE_TOKEN|OPENAI_API_KEY|CONVEX_DEPLOY_KEY/.test(widget.text)) {
      throw new Error("Jarvis dashboard resource contains a forbidden credential name.");
    }

    let dashboard = await callDashboardTool(client, "show_jarvis_dashboard");
    if (dashboard.status.status !== "ok") {
      throw new Error(`Unexpected Jarvis status: ${dashboard.status.status}`);
    }
    if (
      dashboard.status.provider.name !== "convex" ||
      dashboard.status.provider.reachability !== "ok" ||
      dashboard.status.provider.authentication !== "ok" ||
      dashboard.status.provider.schemaCompatibility !== "compatible" ||
      dashboard.status.provider.deploymentVersion !== deployment
    ) {
      throw new Error("Jarvis MCP dashboard reported an unexpected Convex provider state.");
    }

    dashboard = await callDashboardTool(client, "create_task", {
      title: taskTitle,
      category: "commissioning",
    });
    const createdTask = dashboard.tasks.find((task) => task.title === taskTitle);
    if (!createdTask) throw new Error("MCP task creation was not visible in the refreshed dashboard.");
    taskId = createdTask.id;

    dashboard = await callDashboardTool(client, "update_task", {
      taskId,
      title: updatedTaskTitle,
      category: "commissioning-verified",
    });
    const updatedTask = dashboard.tasks.find((task) => task.id === taskId);
    if (
      !updatedTask ||
      updatedTask.title !== updatedTaskTitle ||
      updatedTask.category !== "commissioning-verified"
    ) {
      throw new Error("MCP task update was not persisted correctly.");
    }

    dashboard = await callDashboardTool(client, "complete_task", { taskId });
    if (!dashboard.tasks.find((task) => task.id === taskId)?.completed) {
      throw new Error("MCP task completion was not persisted correctly.");
    }

    dashboard = await callDashboardTool(client, "create_reminder", {
      title: reminderTitle,
      due: { text: "tomorrow 9am", timezone: "Australia/Melbourne" },
    });
    const createdReminder = dashboard.reminders.find(
      (reminder) => reminder.title === reminderTitle,
    );
    if (!createdReminder) {
      throw new Error("MCP reminder creation was not visible in the refreshed dashboard.");
    }
    reminderId = createdReminder.id;

    dashboard = await callDashboardTool(client, "update_reminder", {
      reminderId,
      title: updatedReminderTitle,
      due: null,
    });
    const updatedReminder = dashboard.reminders.find((reminder) => reminder.id === reminderId);
    if (
      !updatedReminder ||
      updatedReminder.title !== updatedReminderTitle ||
      updatedReminder.dueRaw !== undefined ||
      updatedReminder.dueAt !== undefined
    ) {
      throw new Error("MCP reminder update was not persisted correctly.");
    }

    dashboard = await callDashboardTool(client, "delete_task", { taskId });
    if (dashboard.tasks.some((task) => task.id === taskId)) {
      throw new Error("MCP task deletion did not remove the commissioning record.");
    }
    taskId = null;

    dashboard = await callDashboardTool(client, "delete_reminder", { reminderId });
    if (dashboard.reminders.some((reminder) => reminder.id === reminderId)) {
      throw new Error("MCP reminder deletion did not remove the commissioning record.");
    }
    reminderId = null;

    console.log(
      `Jarvis MCP preview smoke passed for ${deployment}: tools, widget, status, task lifecycle, reminder lifecycle, and cleanup verified.`,
    );
  } finally {
    await cleanupTool(client, "delete_task", "taskId", taskId);
    await cleanupTool(client, "delete_reminder", "reminderId", reminderId);
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Jarvis MCP preview smoke failed: ${message}`);
  process.exitCode = 1;
});
