import { createAgentSystem } from "./system.js";
import { runSystemCheck } from "./systemCheck.js";

async function main(): Promise<void> {
  const system = createAgentSystem();
  const report = await runSystemCheck(system);

  console.log("=== JARVIS AGENT SYSTEM CHECK ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(report.allValid ? "ALL VALIDATIONS PASSED" : "VALIDATION FAILURES PRESENT");

  if (!report.allValid) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Agent system check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
