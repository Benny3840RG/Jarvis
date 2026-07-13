import { loadEnvFile } from "node:process";

import { ConvexPersistence } from "../persistence/persistence.js";
import { redactSecret, runConvexSmoke } from "./convexSmoke.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  await runConvexSmoke(
    () => new ConvexPersistence(),
    process.env.CONVEX_DEPLOYMENT,
  );
}

main().catch((error: unknown) => {
  console.error("Convex smoke failed:", redactSecret(error, process.env.JARVIS_SERVICE_TOKEN));
  process.exitCode = 1;
});
