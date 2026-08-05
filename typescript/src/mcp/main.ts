import { loadEnvFile } from "node:process";

import { resolveJarvisMcpConfig } from "./config.js";
import { startJarvisMcpHttpServer } from "./httpServer.js";
import { createPostHogTelemetryFromEnv } from "../observability/posthog.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const running = await startJarvisMcpHttpServer(
    resolveJarvisMcpConfig(),
    undefined,
    createPostHogTelemetryFromEnv(),
  );
  console.log(`Jarvis MCP preview is listening on ${running.url}`);

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch(() => {
  console.error(
    "Jarvis MCP preview failed to start. Check the service token, API URL, host and port configuration.",
  );
  process.exitCode = 1;
});
