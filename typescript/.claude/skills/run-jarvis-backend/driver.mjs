#!/usr/bin/env node
// Driver for the Jarvis TypeScript backend (typescript/). Boots the real
// createJarvisHttpApp() / startJarvisMcpHttpServer() functions the same way
// `npm run start:http` / `npm run start:mcp` do, but with local (non-Convex)
// persistence so it runs with zero external credentials. See SKILL.md.
//
// Usage (run from typescript/):
//   node .claude/skills/run-jarvis-backend/driver.mjs smoke   # one-shot: boot, exercise, verify, exit
//   node .claude/skills/run-jarvis-backend/driver.mjs serve   # boot and hold open for manual curl/MCP calls

import { createJarvisHttpApp } from "../../../src/http/app.ts";
import { InMemoryNoteStore } from "../../../src/notes/inMemoryNoteStore.ts";
import { startJarvisMcpHttpServer } from "../../../src/mcp/httpServer.ts";
import { resolveJarvisMcpConfig } from "../../../src/mcp/config.ts";
import { createPostHogTelemetryFromEnv } from "../../../src/observability/posthog.ts";

const HTTP_PORT = Number(process.env.DRIVER_HTTP_PORT ?? 3901);
const MCP_PORT = Number(process.env.DRIVER_MCP_PORT ?? 8888);
const SERVICE_TOKEN =
  process.env.JARVIS_SERVICE_TOKEN ?? "local-dev-driver-token-please-be-at-least-32-chars";

process.env.JARVIS_SERVICE_TOKEN = SERVICE_TOKEN;
process.env.JARVIS_API_BASE_URL ??= `http://127.0.0.1:${HTTP_PORT}`;
process.env.JARVIS_MCP_PORT ??= String(MCP_PORT);

const authHeader = { authorization: `Bearer ${SERVICE_TOKEN}` };

async function bootHttp() {
  // Real production code (src/http/main.ts) resolves persistence from env and
  // always uses Convex for notes when JARVIS_ENVIRONMENT-style config is
  // present (see app.ts's ConvexNoteStore comment) — that needs a live Convex
  // deployment + JARVIS_SERVICE_TOKEN this driver can't provision. Overriding
  // noteStore is the same pattern this repo's own commissioning tools use
  // (src/tools/runPostHogCommissioning.ts) to run the real app with zero
  // external dependencies. Nothing else needs overriding: PERSISTENCE_PROVIDER
  // defaults to "json" (src/persistence/providerSelection.ts), so every other
  // store is already file-backed/in-memory without any extra config.
  const app = await createJarvisHttpApp({ noteStore: new InMemoryNoteStore(), logger: false });
  await app.listen({ host: "127.0.0.1", port: HTTP_PORT });
  return app;
}

async function bootMcp() {
  return startJarvisMcpHttpServer(
    resolveJarvisMcpConfig(),
    undefined,
    createPostHogTelemetryFromEnv(),
  );
}

async function mcpCall(url, method, params = {}, id = 1) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

async function smoke() {
  let ok = true;
  const check = (label, condition, detail) => {
    console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
    if (!condition) ok = false;
  };

  const app = await bootHttp();
  console.log(`HTTP listening on http://127.0.0.1:${HTTP_PORT}`);
  const mcp = await bootMcp();
  console.log(`MCP listening on ${mcp.url}`);

  try {
    const health = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`);
    check("GET /healthz", health.status === 200, `status ${health.status}`);

    const status = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/status`, {
      headers: authHeader,
    });
    check("GET /api/v1/status", status.status === 200, `status ${status.status}`);

    // Idempotency-Key is required on every mutating task/reminder request —
    // 8 to 128 "safe" characters. A bodyless POST (like .../complete) must
    // NOT carry content-type: application/json, or Fastify's body parser
    // rejects the empty body before the handler ever runs (400).
    const create = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/tasks`, {
      method: "POST",
      headers: { ...authHeader, "content-type": "application/json", "idempotency-key": "driver-smoke-create-1" },
      body: JSON.stringify({ title: "Driver smoke-test task" }),
    });
    const created = await create.json();
    check("POST /api/v1/tasks", create.status === 201, `status ${create.status}`);
    const taskId = created?.data?.id;

    const got = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/tasks/${taskId}`, {
      headers: authHeader,
    });
    check("GET /api/v1/tasks/:id", got.status === 200, `status ${got.status}`);

    const completed = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { ...authHeader, "idempotency-key": "driver-smoke-complete-1" },
    });
    const completedBody = await completed.json();
    check(
      "POST /api/v1/tasks/:id/complete",
      completed.status === 201 && completedBody?.data?.completed === true,
      `status ${completed.status}`,
    );

    const init = await mcpCall(mcp.url, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "driver-smoke", version: "0" },
    });
    check(
      "MCP initialize",
      init.status === 200 && init.body?.result?.serverInfo?.name === "jarvis-private-preview",
      `status ${init.status}`,
    );

    const list = await mcpCall(mcp.url, "tools/list", {}, 2);
    check(
      "MCP tools/list",
      list.status === 200 && Array.isArray(list.body?.result?.tools) && list.body.result.tools.length > 0,
      `${list.body?.result?.tools?.length ?? 0} tools`,
    );
  } finally {
    await mcp.close();
    await app.close();
  }

  console.log(ok ? "\nAll checks passed." : "\nSome checks FAILED.");
  process.exitCode = ok ? 0 : 1;
}

async function serve() {
  const app = await bootHttp();
  console.log(`HTTP listening on http://127.0.0.1:${HTTP_PORT}`);
  const mcp = await bootMcp();
  console.log(`MCP listening on ${mcp.url}`);
  console.log(`\nService token: ${SERVICE_TOKEN}`);
  console.log(`\nTry:\n  curl http://127.0.0.1:${HTTP_PORT}/healthz`);
  console.log(
    `  curl -H "authorization: Bearer ${SERVICE_TOKEN}" http://127.0.0.1:${HTTP_PORT}/api/v1/status`,
  );
  console.log("\nCtrl+C to stop.");
  const shutdown = async () => {
    await mcp.close();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const command = process.argv[2] ?? "smoke";
if (command === "smoke") await smoke();
else if (command === "serve") await serve();
else {
  console.error(`Unknown command "${command}". Use "smoke" or "serve".`);
  process.exitCode = 1;
}
