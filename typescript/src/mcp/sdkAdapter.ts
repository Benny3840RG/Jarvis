/**
 * The single entry point through which the Jarvis MCP server plane touches the
 * upstream Model Context Protocol SDK.
 *
 * Acquisition plan PR D ("MCP SDK … behind a Jarvis adapter"): the SDK is an
 * acquired component that must sit *underneath* Jarvis authority, never become
 * it. Routing every `src/mcp` use of the SDK through this one module gives that
 * boundary a concrete shape:
 *
 *   - an SDK major is adopted by changing this file alone, not scattered
 *     imports; and
 *   - there is one reviewed place where the SDK surface Jarvis depends on is
 *     named, which `McpCapabilityGuard` (PR E) can later narrow.
 *
 * As of the v2 migration (#562) the monolithic `@modelcontextprotocol/sdk` 1.x
 * is replaced by the split `@modelcontextprotocol/server` 2.x package. The
 * server plane needs the `McpServer` registration surface plus the HTTP serving
 * entry point (`createMcpHandler`, which supersedes the removed
 * `StreamableHTTPServerTransport`). Both come from `@modelcontextprotocol/server`.
 *
 * `tests/mcpSdkAdapter.test.ts` enforces the boundary: no other module under
 * `src/mcp/` may import `@modelcontextprotocol/server` directly. This module is
 * a thin re-export — it changes no behaviour of its own. It deliberately does
 * not touch `@modelcontextprotocol/ext-apps`, a separate acquired package.
 */
export { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
export type { McpHttpHandler } from "@modelcontextprotocol/server";
