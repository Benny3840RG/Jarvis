import { loadEnvFile } from "node:process";

import { createJarvisHttpApp } from "../http/app.js";
import { resolveHttpListenConfig } from "../http/config.js";
import { resolveJarvisMcpConfig } from "../mcp/config.js";
import { startJarvisMcpHttpServer } from "../mcp/httpServer.js";
import { applyPreviewEnvironment } from "./environment.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  applyPreviewEnvironment();
  const httpListen = resolveHttpListenConfig();
  const httpApp = await createJarvisHttpApp();
  await httpApp.listen(httpListen);

  const mcpConfig = resolveJarvisMcpConfig({
    ...process.env,
    JARVIS_API_BASE_URL: process.env.JARVIS_API_BASE_URL ?? `http://127.0.0.1:${httpListen.port}`,
  });

  let mcpServer;
  try {
    mcpServer = await startJarvisMcpHttpServer(mcpConfig);
  } catch (error: unknown) {
    await httpApp.close();
    throw error;
  }

  console.log(`Jarvis HTTP is listening on http://${httpListen.host}:${httpListen.port}`);
  console.log(`Jarvis controlled preview is listening on ${mcpServer.url}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await mcpServer.close();
    await httpApp.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch(() => {
  console.error(
    "Jarvis preview failed to start. Check Convex, OpenAI, service-token and local port configuration.",
  );
  process.exitCode = 1;
});
