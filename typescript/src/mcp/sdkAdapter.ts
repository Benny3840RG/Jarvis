/**
 * The single entry point through which the Jarvis MCP server plane touches the
 * upstream Model Context Protocol SDK (`@modelcontextprotocol/sdk`).
 *
 * Acquisition plan PR D ("MCP SDK … behind a Jarvis adapter"): the SDK is an
 * acquired component that must sit *underneath* Jarvis authority, never become
 * it. Routing every `src/mcp` use of the SDK through this one module gives that
 * boundary a concrete shape:
 *
 *   - a future SDK major (the plan's "v2"; the latest published SDK is still
 *     1.x, so this is preparation, not a version bump) is adopted by changing
 *     this file alone, not scattered imports; and
 *   - there is one reviewed place where the SDK surface Jarvis depends on is
 *     named, which `McpCapabilityGuard` (PR E) can later narrow.
 *
 * `tests/mcpSdkAdapter.test.ts` enforces the boundary: no other module under
 * `src/mcp/` may import `@modelcontextprotocol/sdk` directly. This module is a
 * pure re-export — it changes no behaviour, so the existing MCP suite passes
 * unchanged. It deliberately does not touch `@modelcontextprotocol/ext-apps`,
 * a separate acquired package.
 */
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
