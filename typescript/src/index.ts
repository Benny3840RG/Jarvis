import { loadEnvFile } from "node:process";

import { runCli } from "./cli.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  await runCli();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
