/**
 * McpCapabilityGuard — a per-session allow-list over the MCP tool surface
 * (roadmap PR E, toward AUTH-INV-03 "MCP cannot bypass ΩΣ").
 *
 * A session may invoke only the tools its granted capability set names, and
 * nothing else. The guard fails closed: an unknown tool, a tool outside the
 * grant, and an empty grant all deny. It is a pure decision function with no
 * ambient authority — it decides allow/deny; it does not itself call, approve,
 * or execute anything.
 *
 * It cannot widen the MCP surface. The universe of grantable tools is exactly
 * the keys of `MCP_TOOL_OPERATIONS` — the declared tool→operation map that
 * `tests/mcpOperationContract.test.ts` already holds to a strict subset of the
 * OpenAPI operator API, and that `tests/authorityContract.test.ts` proves
 * carries no approve/execute/revoke/merge/deploy operation. So a grant can
 * never name an operation MCP does not already expose, let alone an authority
 * operation. Constructing a guard with an unknown tool name throws rather than
 * silently ignoring it, so a typo'd or stale grant is a loud configuration
 * error, not a quiet hole.
 *
 * Not yet wired into the live `callTool` path: that needs a per-session grant
 * source (the HTTP transport has no session identity today) and per-handler
 * interception in `createJarvisMcpServer`, which is the next PR-E slice. Until
 * the guard is enforced at the boundary it is not cited as AUTH-INV-03
 * evidence.
 */
import { MCP_TOOL_OPERATIONS } from "./operationContract.js";

/** The complete set of tools a capability grant may name: the declared MCP surface. */
export const GRANTABLE_MCP_TOOLS: ReadonlySet<string> = new Set(Object.keys(MCP_TOOL_OPERATIONS));

export type McpCapabilityDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "unknown-tool" | "not-granted" }>;

export class McpCapabilityGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCapabilityGuardError";
  }
}

export class McpCapabilityGuard {
  private readonly granted: ReadonlySet<string>;

  constructor(grantedTools: Iterable<string>) {
    const granted = new Set<string>();
    for (const tool of grantedTools) {
      if (!GRANTABLE_MCP_TOOLS.has(tool)) {
        throw new McpCapabilityGuardError(
          `Cannot grant unknown MCP tool "${tool}"; it is not part of the declared MCP surface.`,
        );
      }
      granted.add(tool);
    }
    this.granted = granted;
  }

  /** Decide whether this session may invoke `tool`. Fail closed on anything unrecognized. */
  decide(tool: string): McpCapabilityDecision {
    if (!GRANTABLE_MCP_TOOLS.has(tool)) return { allowed: false, reason: "unknown-tool" };
    if (!this.granted.has(tool)) return { allowed: false, reason: "not-granted" };
    return { allowed: true };
  }

  allows(tool: string): boolean {
    return this.decide(tool).allowed;
  }

  /** The granted tools, as a sorted array — for evidence/logging, never mutation. */
  grantedTools(): string[] {
    return [...this.granted].sort();
  }
}
