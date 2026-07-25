/**
 * Declared mapping from each MCP-exposed tool to the OpenAPI operations it drives.
 *
 * The private MCP adapter must never reach outside the versioned HTTP contract in
 * `openapi/jarvis.openapi.json`. `tests/mcpOperationContract.test.ts` enforces two
 * things against this mapping:
 *
 *   1. its keys exactly match the tools registered by `createJarvisMcpServer`, so a
 *      new or removed tool cannot drift in without updating this contract; and
 *   2. every operation listed here exists in the OpenAPI document, so the MCP
 *      surface stays a strict subset of the documented operator API.
 *
 * Only the primary operation of each tool is listed. Mutating tools additionally
 * re-read the dashboard to build their response, but those read operations
 * (`GET /api/v1/status`, `/api/v1/tasks`, `/api/v1/reminders`) are already declared
 * by the read-only tools below.
 */
export type OpenApiOperation = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
};

export const MCP_TOOL_OPERATIONS: Readonly<Record<string, readonly OpenApiOperation[]>> = {
  show_jarvis_dashboard: [
    { method: "GET", path: "/api/v1/status" },
    { method: "GET", path: "/api/v1/tasks" },
    { method: "GET", path: "/api/v1/reminders" },
  ],
  get_jarvis_status: [{ method: "GET", path: "/api/v1/status" }],
  list_tasks: [{ method: "GET", path: "/api/v1/tasks" }],
  get_task: [{ method: "GET", path: "/api/v1/tasks/{taskId}" }],
  create_task: [{ method: "POST", path: "/api/v1/tasks" }],
  update_task: [{ method: "PATCH", path: "/api/v1/tasks/{taskId}" }],
  complete_task: [{ method: "POST", path: "/api/v1/tasks/{taskId}/complete" }],
  delete_task: [{ method: "DELETE", path: "/api/v1/tasks/{taskId}" }],
  list_reminders: [{ method: "GET", path: "/api/v1/reminders" }],
  get_reminder: [{ method: "GET", path: "/api/v1/reminders/{reminderId}" }],
  create_reminder: [{ method: "POST", path: "/api/v1/reminders" }],
  update_reminder: [{ method: "PATCH", path: "/api/v1/reminders/{reminderId}" }],
  delete_reminder: [{ method: "DELETE", path: "/api/v1/reminders/{reminderId}" }],
  list_clients: [{ method: "GET", path: "/api/v1/clients" }],
  get_client: [{ method: "GET", path: "/api/v1/clients/{clientId}" }],
  create_client: [{ method: "POST", path: "/api/v1/clients" }],
  update_client: [{ method: "PATCH", path: "/api/v1/clients/{clientId}" }],
  delete_client: [{ method: "DELETE", path: "/api/v1/clients/{clientId}" }],
  list_projects: [{ method: "GET", path: "/api/v1/projects" }],
  get_project: [{ method: "GET", path: "/api/v1/projects/{projectId}" }],
  create_project: [{ method: "POST", path: "/api/v1/projects" }],
  update_project: [{ method: "PATCH", path: "/api/v1/projects/{projectId}" }],
  delete_project: [{ method: "DELETE", path: "/api/v1/projects/{projectId}" }],
  get_daily_brief: [{ method: "GET", path: "/api/v1/brief" }],
  list_errands: [{ method: "GET", path: "/api/v1/errands" }],
  get_errand: [{ method: "GET", path: "/api/v1/errands/{errandId}" }],
  create_errand: [{ method: "POST", path: "/api/v1/errands" }],
  update_errand: [{ method: "PATCH", path: "/api/v1/errands/{errandId}" }],
  delete_errand: [{ method: "DELETE", path: "/api/v1/errands/{errandId}" }],
  list_builds: [{ method: "GET", path: "/api/v1/builds" }],
  get_build: [{ method: "GET", path: "/api/v1/builds/{buildId}" }],
  create_build: [{ method: "POST", path: "/api/v1/builds" }],
  update_build: [{ method: "PATCH", path: "/api/v1/builds/{buildId}" }],
  delete_build: [{ method: "DELETE", path: "/api/v1/builds/{buildId}" }],
  list_build_log: [{ method: "GET", path: "/api/v1/build-logs" }],
  get_build_log: [{ method: "GET", path: "/api/v1/build-logs/{entryId}" }],
  create_build_log: [{ method: "POST", path: "/api/v1/build-logs" }],
  update_build_log: [{ method: "PATCH", path: "/api/v1/build-logs/{entryId}" }],
  delete_build_log: [{ method: "DELETE", path: "/api/v1/build-logs/{entryId}" }],
  list_upgrade: [{ method: "GET", path: "/api/v1/upgrades" }],
  get_upgrade: [{ method: "GET", path: "/api/v1/upgrades/{upgradeId}" }],
  create_upgrade: [{ method: "POST", path: "/api/v1/upgrades" }],
  update_upgrade: [{ method: "PATCH", path: "/api/v1/upgrades/{upgradeId}" }],
  delete_upgrade: [{ method: "DELETE", path: "/api/v1/upgrades/{upgradeId}" }],
  list_asset: [{ method: "GET", path: "/api/v1/assets" }],
  get_asset: [{ method: "GET", path: "/api/v1/assets/{assetId}" }],
  create_asset: [{ method: "POST", path: "/api/v1/assets" }],
  update_asset: [{ method: "PATCH", path: "/api/v1/assets/{assetId}" }],
  delete_asset: [{ method: "DELETE", path: "/api/v1/assets/{assetId}" }],
  list_preference: [{ method: "GET", path: "/api/v1/preferences" }],
  get_preference: [{ method: "GET", path: "/api/v1/preferences/{preferenceId}" }],
  create_preference: [{ method: "POST", path: "/api/v1/preferences" }],
  update_preference: [{ method: "PATCH", path: "/api/v1/preferences/{preferenceId}" }],
  delete_preference: [{ method: "DELETE", path: "/api/v1/preferences/{preferenceId}" }],
} as const;

/** Formats an operation as the `METHOD /path` key used for set comparisons. */
export function formatOperation(operation: OpenApiOperation): string {
  return `${operation.method} ${operation.path}`;
}

/** The distinct set of OpenAPI operations reachable through the MCP adapter. */
export function mcpExposedOperations(): Set<string> {
  const operations = new Set<string>();
  for (const tool of Object.values(MCP_TOOL_OPERATIONS)) {
    for (const operation of tool) operations.add(formatOperation(operation));
  }
  return operations;
}
