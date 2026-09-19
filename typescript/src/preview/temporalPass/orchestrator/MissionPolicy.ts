import type { AgentConfig, MissionIntent } from "../types.js";

/**
 * Deterministic mock agent-assignment policy. Phase 1 has no real LLMs, so
 * this exists only to give the prototype a shape to test against — real
 * agent-selection logic (cost/capability/availability-aware) is future
 * work, not something this experiment tries to get right.
 */
export function selectAgents(intent: MissionIntent): AgentConfig[] {
  if (intent.type === "COMPLEX_MISSION") {
    return [
      {
        identity: "builder",
        provider: "mock",
        model: "mock-builder-v1",
        runtime: "mock",
        role: "BUILDER",
        capabilities: ["coding", "file-ops"],
        permissions: {
          allowedTools: ["github.write", "fs.write"],
          deniedTools: ["github.merge"],
          requireApprovalFor: ["github.merge"],
        },
        budget: { maxTokens: 100_000 },
      },
      {
        identity: "reviewer",
        provider: "mock",
        model: "mock-reviewer-v1",
        runtime: "mock",
        role: "REVIEWER",
        capabilities: ["review", "security-analysis"],
        permissions: {
          allowedTools: ["github.read", "security.scan"],
          deniedTools: [],
          requireApprovalFor: [],
        },
        budget: { maxTokens: 50_000 },
      },
    ];
  }

  return [
    {
      identity: "executor",
      provider: "mock",
      model: "mock-executor-v1",
      runtime: "mock",
      role: "EXECUTOR",
      capabilities: ["tool-use"],
      permissions: {
        allowedTools: ["github.read", "fs.read"],
        deniedTools: [],
        requireApprovalFor: [],
      },
      budget: { maxTokens: 20_000 },
    },
  ];
}
