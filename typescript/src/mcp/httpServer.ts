import { performance } from "node:perf_hooks";
import { createServer, type Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { JarvisMcpConfig } from "./config.js";
import { JarvisApiClient } from "./jarvisApiClient.js";
import { createJarvisMcpServer } from "./server.js";
import { createSentryRuntimeFromEnv, type SentryRuntime } from "../observability/sentry.js";

const MCP_PATH = "/mcp";
const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

export type RunningJarvisMcpServer = {
  url: string;
  close(): Promise<void>;
};

function displayHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startJarvisMcpHttpServer(
  config: JarvisMcpConfig,
  client?: JarvisApiClient,
  observability: SentryRuntime = createSentryRuntimeFromEnv(),
): Promise<RunningJarvisMcpServer> {
  const apiClient = client ?? new JarvisApiClient(config.api, fetch, observability);
  const httpServer = createServer(async (request, response) => {
    const startedAt = performance.now();
    const observe = (statusCode: number): void => {
      void observability
        .recordMeasurement({
          operation: "mcp.request",
          durationMs: performance.now() - startedAt,
          success: statusCode < 500,
          tags: {
            method: request.method ?? "UNKNOWN",
            route: "/mcp",
            status_code: String(statusCode),
          },
        })
        .catch(() => {});
    };
    if (!request.url) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Missing URL");
      observe(400);
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const isMcpPath = url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`);

    if (request.method === "GET" && url.pathname === "/") {
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        .end(JSON.stringify({ status: "ok", service: "jarvis-mcp-preview", endpoint: MCP_PATH }));
      observe(200);
      return;
    }

    if (request.method === "OPTIONS" && isMcpPath) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      response.end();
      observe(204);
      return;
    }

    if (isMcpPath && request.method && MCP_METHODS.has(request.method)) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");

      const server = createJarvisMcpServer(apiClient);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error: unknown) {
        await observability.captureError(error, {
          operation: "mcp.request",
          route: MCP_PATH,
          method: request.method,
        });
        if (!response.headersSent) {
          response
            .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
            .end("Jarvis MCP request failed.");
        }
        observe(500);
      }
      if (response.statusCode < 500) await observe(response.statusCode || 200);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
    await observe(404);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const url = `http://${displayHost(config.host)}:${config.port}${MCP_PATH}`;
  return {
    url,
    close: () => closeHttpServer(httpServer),
  };
}
