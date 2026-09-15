---
name: run-jarvis-backend
description: Build, run, and drive the Jarvis TypeScript backend (HTTP API + MCP server). Use when asked to start Jarvis, run its HTTP/MCP server, smoke-test it, exercise its API, or verify a change works end-to-end without a live Convex deployment.
---

Boots the real `createJarvisHttpApp()` (Nest/Fastify HTTP API) and `startJarvisMcpHttpServer()` (MCP server) from source — the same functions `npm run start:http` / `npm run start:mcp` use — but with local (non-Convex) persistence, so it runs with zero external credentials. Drive it via `.claude/skills/run-jarvis-backend/driver.mjs` (Node + `tsx`, no build step needed). All paths below are relative to `typescript/`.

## Prerequisites

Node 24+ (repo requires `>=20`, tested here on 24.20.0). No OS packages needed — this is a pure Node/TypeScript backend, no browser/GUI involved.

## Setup

```bash
npm ci
```

No env vars are required to run the driver — it sets its own local `JARVIS_SERVICE_TOKEN` and points the MCP server at its own HTTP instance automatically. See Gotchas for why no Convex credentials are needed.

## Build

No separate build step for driving it — `node --import tsx` runs the TypeScript sources directly (same as every `npm run start:*` script in `package.json`).

## Run (agent path)

One-shot smoke test — boots HTTP + MCP, exercises a real task create→get→complete flow over HTTP, does a real MCP `initialize` + `tools/list` handshake, then shuts down and reports pass/fail:

```bash
node --import tsx .claude/skills/run-jarvis-backend/driver.mjs smoke
```

Expected output (this exact run, verified):

```
HTTP listening on http://127.0.0.1:3901
MCP listening on http://127.0.0.1:8888/mcp
PASS GET /healthz — status 200
PASS GET /api/v1/status — status 200
PASS POST /api/v1/tasks — status 201
PASS GET /api/v1/tasks/:id — status 200
PASS POST /api/v1/tasks/:id/complete — status 201
PASS MCP initialize — status 200
PASS MCP tools/list — 61 tools

All checks passed.
```

Exit code is 0 if every check passed, 1 otherwise — safe to use in CI or a pre-flight check.

To keep it running and drive it manually (curl, an MCP client, etc.):

```bash
node --import tsx .claude/skills/run-jarvis-backend/driver.mjs serve
```

This prints the service token and example `curl` commands, then blocks until Ctrl+C. Ports default to `3901` (HTTP) and `8888` (MCP) — override with `DRIVER_HTTP_PORT` / `DRIVER_MCP_PORT` env vars if those collide with something already running (port `3000`, the app's own hardcoded default, was occupied by an unrelated process in this container — that's why the driver defaults elsewhere).

| driver command | what it does |
|---|---|
| `smoke` (default) | Boot, run a full HTTP + MCP checklist, print PASS/FAIL per check, exit 0/1 |
| `serve` | Boot and hold open for manual `curl`/MCP calls until Ctrl+C |

The HTTP API surface (once running): `GET /healthz` (no auth), everything else under `/api/v1/*` needs `Authorization: Bearer <token>`. Mutating requests to tasks/reminders need an `Idempotency-Key` header (8–128 chars) — see Gotchas.

## Run (human path)

The project's own scripts assume a real Convex deployment and (for HTTP) a 32+ char `JARVIS_SERVICE_TOKEN`:

```bash
JARVIS_SERVICE_TOKEN=<32+ chars> npm run start:http   # binds 127.0.0.1:3000
JARVIS_SERVICE_TOKEN=<32+ chars> npm run start:mcp    # binds 127.0.0.1:8787, proxies to the HTTP API above
npm run start                                         # CLI/agent REPL (src/index.ts) — not covered by this skill; not driven or verified this pass
npm run start:preview                                 # preview server (src/preview/main.ts) — not covered by this skill; not driven or verified this pass
```

`start:http` without `PERSISTENCE_PROVIDER=convex` still fails today on the notes store specifically (see Gotchas) unless you're pointed at a real Convex deployment — the driver's `noteStore` override is what makes the agent path credential-free. `start` and `start:preview` weren't exercised in this pass; only documented as they exist in `package.json`.

## Test

```bash
npm run type-check                                               # tsc, both tsconfig.json and convex/tsconfig.json
node --import tsx --test tests/*.test.ts jarvis-console-01/tests/*.test.ts   # ~1530 tests, ~90s
npm run test:convex                                               # vitest, ~370 tests across 41 files, ~30-40s
```

All three verified passing on current `main` (exact counts drift as the repo evolves — treat these as "should be in this ballpark," not a pinned assertion).

## Gotchas

- **Notes always require Convex, regardless of `PERSISTENCE_PROVIDER`.** `src/http/app.ts` has an explicit comment: per the AM-003 commissioning plan, notes have no JSON-file store and always use `ConvexNoteStore` when an environment is present, ignoring the `json`/`convex` provider switch every other store respects. Real production `npm run start:http` therefore can't run credential-free — you must pass `noteStore: new InMemoryNoteStore()` (or a `JsonNoteStore`, if one existed) explicitly through `createJarvisHttpApp()`'s options, which is exactly what this skill's driver does and what the repo's own `src/tools/runPostHogCommissioning.ts`/`runSentryCommissioning.ts` already do for the same reason.
- **`JARVIS_SERVICE_TOKEN` must be ≥32 characters** or `createJarvisHttpApp()` throws `"Jarvis service tokens must be at least 32 characters."` — a short/placeholder token silently isn't good enough.
- **A bodyless POST must not carry `content-type: application/json`.** `POST /api/v1/tasks/:id/complete` takes no body, but sending `content-type: application/json` anyway (with an empty body) makes Fastify's body parser reject the request with a generic `400 Bad Request` *before* the handler runs — the error gives no hint it's a content-type issue. Only set `content-type` on requests that actually have a JSON body.
- **Mutating task/reminder requests need `Idempotency-Key`** (8–128 "safe" characters) or you get a `422` with `"Idempotency-Key must be 8 to 128 safe characters."` — not optional, not defaulted.
- **`main.ts`'s own error handling swallows the real error.** `src/http/main.ts` and `src/mcp/main.ts` both do `main().catch(() => console.error("<generic message>"))`, discarding the actual `Error` object — running `npm run start:http` on a misconfigured environment prints only a generic "check its provider, token, timezone, host, and port configuration" with no actual cause. To debug a real startup failure, call `createJarvisHttpApp()` directly in a one-off script (as the driver does) so the real thrown error surfaces.
- **Port 3000 (the app's hardcoded HTTP default) was already occupied** by an unrelated process in this container. The driver uses `3901`/`8888` instead — if those also collide, override with `DRIVER_HTTP_PORT`/`DRIVER_MCP_PORT`.
- **The MCP server is a thin client of the HTTP server**, not a standalone app — `resolveJarvisMcpConfig()` requires `JARVIS_API_BASE_URL` + `JARVIS_SERVICE_TOKEN` pointing at an already-running HTTP instance. Boot order matters: HTTP first, then MCP.

## Troubleshooting

- **`Jarvis HTTP failed to start. Check its provider, token, timezone, host, and port configuration.`**: the real error is swallowed (see Gotchas). Re-run the failing boot sequence via a one-off `node --import tsx -e "..."` script calling `createJarvisHttpApp()` directly to see the actual thrown message.
- **`Notes require JARVIS_SERVICE_TOKEN.` thrown from `ConvexNoteStore`**: you're running without the `noteStore` override and without Convex credentials. Either supply `noteStore: new InMemoryNoteStore()` (driver path) or set up real Convex + `JARVIS_SERVICE_TOKEN` (production path).
- **`listen EADDRINUSE: address already in use 127.0.0.1:3000`**: something else in the environment already owns port 3000 (unrelated to this app). Use the driver's default ports (3901/8888) or set `DRIVER_HTTP_PORT`/`DRIVER_MCP_PORT`.
- **`POST /api/v1/tasks/:id/complete` returns a generic `400`**: you're sending `content-type: application/json` with no body. Drop that header for bodyless POSTs.
