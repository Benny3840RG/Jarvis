import { createServer, type Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { JarvisMcpConfig } from "./config.js";
import { JarvisApiClient } from "./jarvisApiClient.js";
import { createJarvisMcpServer } from "./server.js";
import {
  captureMcpBoundary,
  createPostHogTelemetryFromEnv,
  type PostHogTelemetry,
} from "../observability/posthog.js";

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

function originAllowed(config: JarvisMcpConfig, origin: string | undefined): boolean {
  return origin === undefined || (config.allowedOrigins ?? []).includes(origin);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    Vary: "Origin",
  };
}

export async function startJarvisMcpHttpServer(
  config: JarvisMcpConfig,
  client: JarvisApiClient = new JarvisApiClient(config.api),
  telemetry: PostHogTelemetry = createPostHogTelemetryFromEnv(),
): Promise<RunningJarvisMcpServer> {
  const httpServer = createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Missing URL");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const isMcpPath = url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;

    if (request.method === "GET" && url.pathname === "/") {
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        .end(JSON.stringify({ status: "ok", service: "jarvis-mcp-preview", endpoint: MCP_PATH }));
      return;
    }

    if (request.method === "OPTIONS" && isMcpPath) {
      if (!originAllowed(config, origin)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
        return;
      }
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }

    if (isMcpPath && request.method && MCP_METHODS.has(request.method)) {
      if (!originAllowed(config, origin)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
        return;
      }
      for (const [name, value] of Object.entries(corsHeaders(origin)))
        response.setHeader(name, value);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");

      const server = createJarvisMcpServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      const startedAt = performance.now();
      let outcome: "success" | "failure" = "success";
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch {
        outcome = "failure";
        if (!response.headersSent) {
          response
            .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
            .end("Jarvis MCP request failed.");
        }
      } finally {
        captureMcpBoundary(telemetry, {
          outcome,
          durationMs: performance.now() - startedAt,
        });
      }
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
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
