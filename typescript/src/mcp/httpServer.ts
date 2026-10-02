import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createMcpHandler, type McpHttpHandler } from "./sdkAdapter.js";

import { McpCapabilityGuard, resolveMcpCapabilityGrant } from "./capabilityGuard.js";
import type { JarvisMcpConfig } from "./config.js";
import { JarvisApiClient } from "./jarvisApiClient.js";
import { runWithMcpRequestSignal } from "./requestSignal.js";
import { createJarvisMcpServer } from "./server.js";
import {
  captureMcpBoundary,
  createPostHogTelemetryFromEnv,
  type PostHogTelemetry,
} from "../observability/posthog.js";

const MCP_PATH = "/mcp";
const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

/**
 * Cap on a buffered MCP request body. JSON-RPC tool calls are small; this bounds
 * the memory an abusive or runaway client can force before the handler runs.
 */
const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** The request body exceeded {@link MAX_MCP_BODY_BYTES}; mapped to HTTP 413. */
class BodyTooLargeError extends Error {}

/** The client disconnected before the body finished; no response is owed. */
class RequestAbortedError extends Error {}

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

/**
 * Buffer a Node request body with two guards the pre-2.x transport gave us for
 * free: a hard size cap (reject with {@link BodyTooLargeError} → 413 rather than
 * growing the buffer without bound) and cancellation — if the client
 * disconnects (`signal` aborts) the socket is destroyed and the read rejects
 * with {@link RequestAbortedError} instead of draining an abandoned upload.
 */
function readRequestBody(
  request: IncomingMessage,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      run();
    };
    const onAbort = (): void =>
      finish(() => {
        request.destroy();
        reject(new RequestAbortedError());
      });
    if (signal.aborted) {
      reject(new RequestAbortedError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering, but leave the socket alive so the 413 can be written;
        // the handler destroys it once that response has flushed.
        finish(() => {
          request.pause();
          reject(new BodyTooLargeError());
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
    request.on("error", (error) => finish(() => reject(error)));
  });
}

/**
 * Build a web-standard `Request` from the incoming Node request. The MCP 2.x
 * serving entry (`createMcpHandler().fetch`) is fetch-shaped, so the Node HTTP
 * surface is bridged here rather than throughout the server plane. `signal`
 * carries client disconnects into the exchange so an abandoned request is
 * cancelled at the transport, mirroring the pre-2.x `transport.close()` path.
 */
function toWebRequest(
  request: IncomingMessage,
  url: URL,
  body: Buffer,
  signal: AbortSignal,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(url.toString(), {
    method,
    headers,
    signal,
    ...(hasBody ? { body: body as unknown as BodyInit } : {}),
  });
}

/** Stream a web-standard `Response` back onto the Node response, preserving any
 * headers already set on it (CORS, cache-control) — `writeHead` merges those
 * with the response's own, the response's taking precedence. */
async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body) {
    for await (const chunk of webResponse.body as unknown as AsyncIterable<Uint8Array>) {
      response.write(chunk);
    }
  }
  response.end();
}

export async function startJarvisMcpHttpServer(
  config: JarvisMcpConfig,
  client: JarvisApiClient = new JarvisApiClient(config.api),
  telemetry: PostHogTelemetry = createPostHogTelemetryFromEnv(),
): Promise<RunningJarvisMcpServer> {
  // Resolve the deployment's capability ceiling once, at startup, so a
  // misconfigured allowlist fails fast rather than per request. The guard is
  // immutable and shared across requests (the grant is static config today).
  const capabilityGuard = new McpCapabilityGuard(resolveMcpCapabilityGrant(config.capabilities));

  // One fetch-shaped MCP handler for the process. Its default stateless serving
  // builds a fresh, per-request server instance from this factory — the same
  // isolation the pre-2.x per-request transport gave, without a shared session.
  const handler: McpHttpHandler = createMcpHandler(() =>
    createJarvisMcpServer(client, capabilityGuard),
  );

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

      const disconnect = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) disconnect.abort();
      });
      const startedAt = performance.now();
      let outcome: "success" | "failure" = "success";
      try {
        const body = await readRequestBody(request, disconnect.signal, MAX_MCP_BODY_BYTES);
        const webRequest = toWebRequest(request, url, body, disconnect.signal);
        const webResponse = await runWithMcpRequestSignal(disconnect.signal, () =>
          handler.fetch(webRequest),
        );
        await writeWebResponse(response, webResponse);
      } catch (error: unknown) {
        outcome = "failure";
        if (error instanceof RequestAbortedError) {
          // The client is gone; nothing to send. Telemetry still records the failure.
        } else if (error instanceof BodyTooLargeError) {
          if (!response.headersSent) {
            response
              .writeHead(413, { "content-type": "text/plain; charset=utf-8" })
              // Close the connection once the 413 has flushed: the unread body
              // would otherwise desync a keep-alive socket.
              .end("Request body too large.", () => request.destroy());
          } else if (!response.writableFinished) {
            response.end();
          }
        } else if (!response.headersSent) {
          response
            .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
            .end("Jarvis MCP request failed.");
        } else if (!response.writableFinished) {
          response.end();
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
    close: async () => {
      await handler.close();
      await closeHttpServer(httpServer);
    },
  };
}
