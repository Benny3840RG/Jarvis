import { spawn, type ChildProcess } from "node:child_process";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { JarvisApiClient } from "../mcp/jarvisApiClient.js";
import { JARVIS_DASHBOARD_URI } from "../mcp/server.js";
import {
  assertPaddockStatus,
  resolvePaddockConfig,
  type PaddockConfig,
} from "../preview/paddock.js";
import {
  assertPaddockDashboardResource,
  assertPaddockDashboardSnapshot,
  assertRequiredPaddockTools,
} from "../preview/paddockProbe.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeHttp(config: PaddockConfig): Promise<void> {
  const healthUrl = new URL("healthz", config.httpUrl);
  const health = await fetch(healthUrl);
  if (!health.ok) throw new Error(`Jarvis health probe returned HTTP ${health.status}.`);

  const api = new JarvisApiClient({
    baseUrl: config.httpUrl,
    serviceToken: config.serviceToken,
  });
  assertPaddockStatus(await api.getStatus(), config.deployment);
}

async function probeMcp(config: PaddockConfig): Promise<void> {
  const client = new Client({ name: "jarvis-paddock", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(config.mcpUrl));

    const toolList = await client.listTools();
    assertRequiredPaddockTools(toolList.tools.map((tool) => tool.name));

    const resource = await client.readResource({ uri: JARVIS_DASHBOARD_URI });
    assertPaddockDashboardResource(resource.contents);

    const result = await client.callTool({
      name: "show_jarvis_dashboard",
      arguments: {},
    });
    assertPaddockDashboardSnapshot(result, config.deployment);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForProbe(
  name: string,
  child: ChildProcess,
  probe: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Jarvis preview exited before the ${name} probe completed.`);
    }
    try {
      await probe();
      return;
    } catch (error: unknown) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`${name} probe failed: ${errorMessage(lastError)}`);
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`Jarvis preview exited with code ${child.exitCode}.`));
  }
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
      } else {
        reject(new Error(`Jarvis preview exited with code ${String(code)}.`));
      }
    });
  });
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const config = resolvePaddockConfig(process.env);
  const child = spawn(process.execPath, ["--import", "tsx", "src/preview/main.ts"], {
    cwd: process.cwd(),
    env: config.environment,
    stdio: "inherit",
  });

  const shutdown = () => stopChild(child);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await waitForProbe("HTTP/Convex", child, () => probeHttp(config));
    await waitForProbe("MCP/dashboard", child, () => probeMcp(config));

    console.log("");
    console.log("JARVIS PADDOCK READY");
    console.log(`Convex: ${config.deployment}`);
    console.log(`HTTP:   ${config.httpUrl}`);
    console.log(`MCP:    ${config.mcpUrl}`);
    console.log("Press Ctrl+C to shut down the local development paddock.");

    await waitForChildExit(child);
  } catch (error: unknown) {
    stopChild(child);
    throw error;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

main().catch((error: unknown) => {
  console.error(`Jarvis paddock failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
