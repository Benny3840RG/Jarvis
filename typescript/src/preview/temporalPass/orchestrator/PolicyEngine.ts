import type { ToolPermissionResult, ToolRequest } from "../types.js";

/**
 * ⚠️ NON-AUTHORITATIVE PROTOTYPE STUB — grants no Jarvis authority.
 *
 * This is a self-contained tool/operation permission checker for the
 * Temporal PASS experiment ONLY. Per JARVIS-018 (no duplicate/parallel
 * authority implementations without explicit approval), any real
 * integration MUST route external actions through the existing governed
 * execution boundary (ΩΣ / ToolAction / claim / receipt / reconciliation —
 * see `src/safety/safetyBinder.ts` and `src/orchestration/*`), not through
 * this class. `PolicyEngine` may never become an independent execution
 * gate; it exists purely so the mocked passWorkflow activities have
 * something to consult while testing Temporal's durability mechanics.
 */
export class PolicyEngine {
  private readonly allowedTools: Set<string>;
  private readonly deniedTools: Set<string>;

  constructor(options: { allowedTools?: string[]; deniedTools?: string[] } = {}) {
    this.allowedTools = new Set(options.allowedTools ?? []);
    this.deniedTools = new Set(options.deniedTools ?? []);
  }

  async evaluate(request: ToolRequest): Promise<ToolPermissionResult> {
    if (this.deniedTools.has(request.toolName)) {
      return { allowed: false, reason: "Tool explicitly denied" };
    }
    if (!this.allowedTools.has(request.toolName)) {
      return { allowed: false, reason: "Tool not in allowed list" };
    }
    if (request.riskContext.isDestructive && !request.riskContext.isIdempotent) {
      return {
        allowed: false,
        requiresApproval: true,
        approvalLevel: request.riskContext.isOpenWorld ? "BENNY" : "JARVIS",
      };
    }
    if (request.riskContext.isOpenWorld) {
      return { allowed: false, requiresApproval: true, approvalLevel: "BENNY" };
    }
    return { allowed: true };
  }
}
