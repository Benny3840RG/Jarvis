import { loadEnvFile } from "node:process";

import {
  GeminiTotalityReasoner,
  resolveGeminiTotalityConfig,
} from "../integrations/gemini/totalityReasoner.js";
import type { TotalityRequest } from "../runtime/totalityContracts.js";
import type { TotalityReasoningContext } from "../totality/totalityPipeline.js";

// Manual, ad hoc test entrypoint for the Gemini Totality reasoner -- makes a
// real network call and is not part of `npm test`/`npm run check`. Run with:
//   tsx src/tools/runGeminiSmoke.ts "Add a task to repair fence posts and remind me Friday 9am"

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function buildRequest(goal: string): TotalityRequest {
  return {
    requestId: `gemini-smoke-${Date.now()}`,
    projectId: null,
    sessionId: "gemini-smoke",
    taskType: "general_analysis",
    domainContext: ["operations"],
    goal,
    constraints: ["No tool execution", "No memory proposal"],
    inputs: [],
    outputStyle: "default",
    actionPolicy: {
      maximumToolAuthority: "T1",
      requireApprovalBeforeExecution: true,
    },
  };
}

function buildContext(): TotalityReasoningContext {
  return { project: null, proposedAt: new Date().toISOString() };
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const goal = process.argv[2];
  if (!goal) {
    console.error('Usage: tsx src/tools/runGeminiSmoke.ts "<goal text>"');
    process.exitCode = 1;
    return;
  }

  const reasoner = new GeminiTotalityReasoner(resolveGeminiTotalityConfig());
  const result = await reasoner.reason(buildRequest(goal), buildContext());
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
