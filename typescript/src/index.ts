import * as readlinePromises from "node:readline/promises";
import { stdin as input, loadEnvFile, stdout as output } from "node:process";

import { runCli } from "./cli.js";
import { NonBlankReadline } from "./cli/nonBlankReadline.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const readline = readlinePromises.createInterface({ input, output });
  await runCli({ readline: new NonBlankReadline(readline) });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
