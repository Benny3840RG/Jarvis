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
