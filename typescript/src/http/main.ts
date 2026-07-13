import { loadEnvFile } from "node:process";

import { createJarvisHttpApp } from "./app.js";
import { resolveHttpListenConfig } from "./config.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const listen = resolveHttpListenConfig();
  const app = await createJarvisHttpApp();
  await app.listen(listen);
  console.log(`Jarvis HTTP is listening on http://${listen.host}:${listen.port}`);
}

main().catch(() => {
  console.error(
    "Jarvis HTTP failed to start. Check its provider, token, timezone, host, and port configuration.",
  );
  process.exitCode = 1;
});
