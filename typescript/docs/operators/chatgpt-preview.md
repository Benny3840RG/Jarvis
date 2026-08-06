# Jarvis controlled ChatGPT preview

Jarvis Preview 0.1 is a private, single-user operator console for the authorised development stack.
It exposes a stateless Streamable HTTP MCP endpoint at `/mcp` and renders the versioned
`ui://jarvis/dashboard-v1.html` widget inside ChatGPT.

The adapter does not contain a second task or reminder engine. It calls the commissioned Jarvis
HTTP API, which remains the validation, authentication and persistence boundary. The
`JARVIS_SERVICE_TOKEN` is injected by the MCP process and is never returned to ChatGPT, the model,
the widget, or tool arguments.

## Scope

The first preview includes:

- live Jarvis, Convex, Z-State and layer status
- task list, creation, update, completion and explicit deletion
- reminder list, creation, update and explicit deletion
- a black-and-orange Focus, Board, Reminders and Systems dashboard

Totality reasoning, memory changes, tool-action approvals, backups and broad conversation execution
remain REST-only. They are not exposed as preview MCP tools.

## Development configuration

Configure the existing development values in `typescript/.env.local`, including:

```text
PERSISTENCE_PROVIDER=convex
CONVEX_URL=https://outgoing-ram-798.convex.cloud
CONVEX_DEPLOYMENT=dev:outgoing-ram-798
JARVIS_DEPLOYMENT_VERSION=dev:outgoing-ram-798
JARVIS_SERVICE_TOKEN=<development service token>
OPENAI_API_KEY=<development API key>
JARVIS_TIMEZONE=Australia/Melbourne
# Optional: exact browser origins allowed to call the loopback MCP endpoint.
# Leave unset for native/non-browser MCP clients only.
JARVIS_MCP_ALLOWED_ORIGINS=http://127.0.0.1:3000
```

`JARVIS_DEPLOYMENT_VERSION` is the deployment identity reported by the HTTP status contract. The
preview derives it from `CONVEX_DEPLOYMENT` when it is omitted, while explicit mismatches fail the
paddock readiness check.

## Recommended local start

Run the guarded one-command launcher:

```bash
cd typescript
nvm use
npm ci
npm run paddock
```

The launcher validates the authorised development boundary, starts HTTP and MCP, verifies the live
Convex status, reads the dashboard resource, calls the read-only dashboard tool, and then reports:

```text
JARVIS PADDOCK READY
Convex: dev:outgoing-ram-798
HTTP:   http://127.0.0.1:3000/
MCP:    http://127.0.0.1:8787/mcp
```

It does not create, update or delete tasks or reminders. Press `Ctrl+C` to stop both local services.

## Manual local start

To start the commissioned Jarvis HTTP service and MCP adapter without the readiness wrapper:

```bash
cd typescript
nvm use
npm ci
npm run start:preview
```

`start:preview` performs the same development-paddock allowlist checks as `npm run paddock`
before opening either listener. It refuses non-Convex providers, unauthorised deployments, and
production deployment identifiers.

Default local endpoints:

```text
Jarvis HTTP: http://127.0.0.1:3000
Jarvis MCP:  http://127.0.0.1:8787/mcp
```

`npm run start:mcp` starts only the MCP adapter and expects Jarvis HTTP to already be running.
`JARVIS_API_BASE_URL` may override its backend URL.

## Binding guard

The HTTP and MCP adapters bind to loopback by default. Any non-loopback `JARVIS_HTTP_HOST` or
`JARVIS_MCP_HOST` fails closed. There is no environment override for remote binding. OAuth 2.1,
TLS, origin policy and an approved deployment boundary are required before remote service exposure.

## Connect from ChatGPT Developer Mode

1. Keep the MCP process local and expose port `8787` through a temporary HTTPS development tunnel.
2. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and enable Developer Mode.
3. Create a private app using the tunnel URL ending in `/mcp`.
4. Refresh the app after MCP tool or widget metadata changes so ChatGPT reloads the descriptors.
5. Remove or stop the tunnel when the test session is finished.

The preview is not ready for directory submission or a permanent public endpoint. OAuth 2.1 or an
equivalent user-authentication boundary is required before remote or multi-user deployment.

## Safety boundary

- Convex is pinned to `dev:outgoing-ram-798`.
- Production deployment remains prohibited without Benny's explicit production-specific approval.
- Read and write tool annotations describe actual impact.
- Delete tools are destructive and require explicit current-turn intent.
- Widget controls intentionally omit deletion.
- All server and widget outputs are credential-free.
