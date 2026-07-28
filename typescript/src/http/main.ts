import { loadEnvFile } from "node:process";

import { createRuntimeReconciliationHost } from "../reconciliation/runtimeReconciliationHost.js";
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
  const reconciliation = createRuntimeReconciliationHost();
  const app = await createJarvisHttpApp({
    reconciliationHealth: () => reconciliation.health(),
  });

  try {
    await app.listen(listen);
    await reconciliation.start();
  } catch (error: unknown) {
    await reconciliation.stop();
    await app.close();
    throw error;
  }

  console.log(`Jarvis HTTP is listening on http://${listen.host}:${listen.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await reconciliation.stop();
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch(() => {
  console.error(
    "Jarvis HTTP failed to start. Check its provider, token, timezone, host, and port configuration.",
  );
  process.exitCode = 1;
});
