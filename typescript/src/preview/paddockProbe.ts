import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import type { SystemStatus } from "../http/contracts.js";
import type { DashboardSnapshot } from "../mcp/jarvisApiClient.js";
import { REQUIRED_PADDOCK_TOOLS, assertPaddockStatus } from "./paddock.js";

/**
 * Pure validation helpers for the Jarvis development paddock readiness probe.
 *
 * These functions contain the acceptance logic exercised by `npm run paddock`
 * against a live preview, but they take plain protocol payloads so the same
 * checks can run unattended in CI without an authorised Convex deployment or
 * OpenAI credentials. Keeping them here makes the readiness contract a dedicated
 * smoke test rather than behaviour that only exists inside the launcher.
 */

/** The marker text the operator-console widget must contain to be considered valid. */
export const PADDOCK_DASHBOARD_MARKER = "JARVIS // OPERATOR CONSOLE";

/** The MIME type the dashboard resource must advertise. */
export const PADDOCK_DASHBOARD_MIME_TYPE = RESOURCE_MIME_TYPE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Confirms every tool the paddock depends on is present in the MCP tool list. */
export function assertRequiredPaddockTools(toolNames: Iterable<string>): void {
  const available = new Set(toolNames);
  for (const tool of REQUIRED_PADDOCK_TOOLS) {
    if (!available.has(tool)) throw new Error(`Required MCP tool is missing: ${tool}`);
  }
}

/** Confirms the dashboard resource is the single, correctly typed operator-console widget. */
export function assertPaddockDashboardResource(contents: ReadResourceResult["contents"]): void {
  const widget = contents[0];
  if (
    contents.length !== 1 ||
    !widget ||
    widget.mimeType !== PADDOCK_DASHBOARD_MIME_TYPE ||
    !("text" in widget) ||
    typeof widget.text !== "string" ||
    !widget.text.includes(PADDOCK_DASHBOARD_MARKER)
  ) {
    throw new Error("Jarvis MCP dashboard resource is unavailable or invalid.");
  }
}

/** Validates the `show_jarvis_dashboard` tool result and returns its snapshot. */
export function extractPaddockDashboardSnapshot(result: unknown): DashboardSnapshot {
  if (!isRecord(result) || !("content" in result)) {
    throw new Error("Jarvis MCP dashboard tool did not return a valid snapshot.");
  }
  const toolResult = result as CallToolResult;
  if (toolResult.isError || !isRecord(toolResult.structuredContent)) {
    throw new Error("Jarvis MCP dashboard tool did not return a valid snapshot.");
  }
  return toolResult.structuredContent as DashboardSnapshot;
}

/**
 * Full acceptance check for the dashboard tool call: validates the result shape
 * and asserts the reported provider state matches the commissioned deployment.
 */
export function assertPaddockDashboardSnapshot(result: unknown, deployment: string): SystemStatus {
  const dashboard = extractPaddockDashboardSnapshot(result);
  assertPaddockStatus(dashboard.status, deployment);
  return dashboard.status;
}
