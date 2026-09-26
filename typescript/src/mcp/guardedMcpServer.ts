/**
 * Binds an McpCapabilityGuard to an McpServer so a tool outside the session's
 * grant is refused at call time (roadmap PR E — enforce AUTH-INV-03's
 * per-session capability guard).
 *
 * The guard is bound by wrapping the server's own `registerTool`, which every
 * tool registration funnels through (`registerAppTool` from `ext-apps` and any
 * direct call alike), so a single wrap covers the whole tool surface with no
 * per-tool edits. Each registered handler is wrapped to consult the guard
 * first: a denied call returns an `isError` result and never runs the real
 * handler, so it never reaches the operator API.
 *
 * The guard is fed a resolved grant set by the caller (see
 * `resolveMcpCapabilityGrant`); this module does no config lookup, which keeps
 * the seam for a future session-scoped grant
 * (`effectiveGrant = staticConfigCeiling ∩ sessionGrant`) — a token can only
 * ever narrow the deployment's grant, never widen it.
 *
 * Types are derived from the adapter's `McpServer` rather than imported from
 * `@modelcontextprotocol/sdk` directly, so the MCP-SDK adapter boundary (PR D,
 * enforced by `tests/mcpSdkAdapter.test.ts`) stays intact.
 */
import { type McpCapabilityGuard } from "./capabilityGuard.js";
import { type McpServer } from "./sdkAdapter.js";

type RegisterTool = McpServer["registerTool"];

/** Wrap `cb` so it refuses when `name` is outside the guard's grant. */
function guardToolCallback<Cb extends (...args: never[]) => unknown>(
  name: string,
  guard: McpCapabilityGuard,
  cb: Cb,
): Cb {
  return ((...args: Parameters<Cb>): unknown => {
    if (guard.allows(name)) return cb(...args);
    return {
      content: [
        {
          type: "text" as const,
          text: `Tool "${name}" is not in this session's capability grant.`,
        },
      ],
      isError: true as const,
    };
  }) as Cb;
}

/**
 * Replace `server.registerTool` with a wrapper that guards every subsequently
 * registered tool. Call this before any tool is registered on `server`.
 */
export function bindCapabilityGuard(server: McpServer, guard: McpCapabilityGuard): void {
  const original = server.registerTool.bind(server) as RegisterTool;
  const guarded = ((name: string, ...rest: unknown[]): unknown => {
    // registerTool is `(name, config, callback)`. Guard the callback (the last
    // argument) and pass the rest through untouched.
    const callback = rest[rest.length - 1] as (...args: never[]) => unknown;
    const head = rest.slice(0, -1);
    const wrappedCallback = guardToolCallback(name, guard, callback);
    return (original as (...a: unknown[]) => unknown)(name, ...head, wrappedCallback);
  }) as RegisterTool;
  server.registerTool = guarded;
}
