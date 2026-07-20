import { runGovernedAutonomyDemo } from "./autonomyDemo.js";
import { createAgentSystem } from "./system.js";
import { runSystemCheck } from "./systemCheck.js";

async function main(): Promise<void> {
  const report = await runSystemCheck(createAgentSystem());

  console.log("=== JARVIS AGENT SYSTEM CHECK ===");
  console.log(JSON.stringify(report, null, 2));

  const autonomy = runGovernedAutonomyDemo(createAgentSystem());
  console.log("=== GOVERNED AUTONOMY DEMO ===");
  console.log(JSON.stringify(autonomy, null, 2));
  console.log(
    autonomy.afterWarmup.active
      ? "AUTONOMY ACTIVATED after sufficient safe, healthy history"
      : "AUTONOMY REMAINED GATED",
  );

  console.log(report.allValid ? "ALL VALIDATIONS PASSED" : "VALIDATION FAILURES PRESENT");

  if (!report.allValid) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Agent system check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
