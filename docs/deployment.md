# Jarvis deployment and token rotation

This runbook documents Jarvis's current development deployment, local environment, GitHub Actions secrets, backups, and service-token rotation.

## Deployment decision

The confirmed target for this deployment is the existing private Convex development stack:

```text
Runtime: Node.js 24
Persistence: Convex
Deployment: dev:outgoing-ram-798
HTTP/MCP exposure: localhost only
```

The repository does not currently have an authorised private-server or managed-platform target.
The guarded `Development commissioning` workflow is the supported way to validate and sync this
development stack. It must be run from `main`, requires the exact `COMMISSION DEV` confirmation,
and refuses any deployment identity other than the one listed above.

## Hard deployment boundary

Jarvis currently has one authorised Convex deployment:

```text
Deployment: dev:outgoing-ram-798
URL: https://outgoing-ram-798.convex.cloud
```

This is a persistent development deployment, not an anonymous or disposable backend. Test records must be cleaned up after smoke tests.

**No Convex production deployment is authorised.** Do not run `npx convex deploy`, create a production deployment, or attach Jarvis to another Convex project without Benny's explicit approval.

## Local development environment

Convex creates and updates `typescript/.env.local`. Jarvis also loads this file at runtime. It must remain ignored by Git and should have private file permissions.

```text
CONVEX_DEPLOYMENT=dev:outgoing-ram-798
CONVEX_URL=https://outgoing-ram-798.convex.cloud
PERSISTENCE_PROVIDER=convex
JARVIS_SERVICE_TOKEN=<strong random development secret>
JARVIS_TIMEZONE=Australia/Melbourne
OPENAI_API_KEY=<server-side OpenAI API key>
```

Rules:

- `JARVIS_SERVICE_TOKEN` in `.env.local` must exactly match the value stored in the Convex development environment.
- `OPENAI_API_KEY` is server-only. Never expose it in browser code, logs, screenshots, issues, pull requests, or chat.
- `CONVEX_URL` is routing information, not an authentication secret.
- Never commit `.env.local` or any secret-bearing environment file.

Set the development service token interactively so it does not appear in shell history:

```bash
cd typescript
npx convex env set JARVIS_SERVICE_TOKEN
```

## GitHub Actions secrets

A development-only sync workflow may use these repository secrets:

```text
CONVEX_DEPLOY_KEY
JARVIS_SERVICE_TOKEN
OPENAI_API_KEY
```

`CONVEX_DEPLOY_KEY` must be a deploy key generated for the existing development deployment `dev:outgoing-ram-798`. Do not add a production deploy key to this repository.

GitHub hides secret values after they are saved. Only the secret names should be visible in repository settings.

## Development commissioning

After the three development-only repository secrets are configured, open
**Actions → Development commissioning → Run workflow** on the `main` branch and enter
`COMMISSION DEV`. The workflow installs the Node.js version from `typescript/.nvmrc`, runs the
complete TypeScript verification gate, syncs Convex with:

```text
npx convex dev --once --tail-logs disable
```

It then runs the self-cleaning Convex smoke test and starts the HTTP service to verify liveness,
authenticated status, and operator boundaries. The workflow redacts configured credentials from
diagnostics and explicitly reports that production was not performed.

## JSON provider

When `PERSISTENCE_PROVIDER` is unset or set to `json`, the maintained TypeScript runtime stores data at:

```text
typescript/data/jarvis-state.json
```

The file, its lock file, temporary writes, backups, and corrupt-file quarantine copies must not be committed.

## Environment variables

All environment variables are loaded from `typescript/.env.local` at startup. Variables marked **required** cause a hard startup failure if absent or malformed. Variables marked **optional** have safe defaults.

| Variable | Required / Optional | Default | Purpose |
| --- | --- | --- | --- |
| `JARVIS_SERVICE_TOKEN` | **Required** | — | Current bearer token required by all authenticated HTTP and Convex operations. Must be a strong random secret; whitespace is rejected. |
| `JARVIS_SERVICE_TOKEN_PREVIOUS` | Optional | — | Previous token accepted during a controlled rotation window only. Remove after rotation is complete. |
| `JARVIS_TIMEZONE` | **Required** for Totality | — | IANA timezone string (e.g. `Australia/Melbourne`). Invalid values cause the status and Totality endpoints to return `503`. |
| `PERSISTENCE_PROVIDER` | Optional | `json` | `json` or `convex`. With `json`, data is stored in `typescript/data/jarvis-state.json`. With `convex`, `CONVEX_URL` is required. |
| `CONVEX_URL` | **Required** when `PERSISTENCE_PROVIDER=convex` | — | Full URL of the authorised Convex deployment (e.g. `https://outgoing-ram-798.convex.cloud`). |
| `OPENAI_API_KEY` | **Required** for Totality reasoning | — | Server-side OpenAI API key. Never expose this in browser code, logs, issues, or chat. |
| `JARVIS_HTTP_HOST` | Optional | `127.0.0.1` | Listener address for the HTTP service. Change only to expose the service on a non-loopback interface. |
| `JARVIS_HTTP_PORT` | Optional | `3000` | Listener TCP port for the HTTP service. Must be in the valid port range. |
| `JARVIS_SOURCE_VERSION` | Optional | `development` | Git SHA or version string embedded in health and status responses for diagnostics. |
| `JARVIS_DEPLOYMENT_VERSION` | Optional | — | Deployment identifier (e.g. `dev:outgoing-ram-798`) embedded in status responses. |
| `CONVEX_DEPLOYMENT` | Set by Convex | — | Set automatically by `npx convex dev` when the project is linked. Required by the Convex SDK and the smoke test (`npm run smoke:convex`). Do not set manually. |

## Startup validation

Jarvis validates all required configuration at startup before accepting requests. Validation failures produce a clear error message and prevent the service from starting.

To verify that startup configuration is correct before going live:

```bash
cd typescript
npm run start:http &
sleep 3

# Public liveness check (no token required)
curl -f http://127.0.0.1:3000/healthz

# Authenticated status check (token required)
TOKEN="$(grep '^JARVIS_SERVICE_TOKEN=' .env.local | cut -d= -f2)"
curl -f -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/v1/status | jq .
```

A healthy status response has `"status": "ok"`, provider `"reachability": "ok"`, and (for Convex) `"authentication": "ok"`.

If the status endpoint returns `503`, check the error detail: it will name either `timezone-unavailable` or `persistence-unavailable` as the `type` field.

## HTTP service configuration

The HTTP server starts with:

```bash
cd typescript
npm run start:http
```

The full environment variable reference is in the table above. The most common local configuration is:

```text
PERSISTENCE_PROVIDER=convex
JARVIS_SERVICE_TOKEN=<strong random development secret>
JARVIS_TIMEZONE=Australia/Melbourne
CONVEX_DEPLOYMENT=dev:outgoing-ram-798
CONVEX_URL=https://outgoing-ram-798.convex.cloud
OPENAI_API_KEY=<server-side OpenAI API key>
```

The HTTP and MCP services must retain their loopback defaults:

```text
JARVIS_HTTP_HOST=127.0.0.1
JARVIS_MCP_HOST=127.0.0.1
```

Do not change either value for a remote deployment. Remote exposure requires an approved OAuth 2.1
or equivalent user-authentication boundary, TLS, origin policy, and deployment review.

## Service-token rotation

Jarvis accepts one current token and one optional previous token. Rotation must update the Convex development environment and local callers without exposing either value.

From `typescript/`:

```bash
set -a
. ./.env.local
set +a

OLD_TOKEN="$JARVIS_SERVICE_TOKEN"
NEW_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

printf '%s\n' "$OLD_TOKEN" | npx convex env set JARVIS_SERVICE_TOKEN_PREVIOUS
printf '%s\n' "$NEW_TOKEN" | npx convex env set JARVIS_SERVICE_TOKEN

sed -i '/^JARVIS_SERVICE_TOKEN=/d' .env.local
printf 'JARVIS_SERVICE_TOKEN=%s\n' "$NEW_TOKEN" >> .env.local
chmod 600 .env.local

unset JARVIS_SERVICE_TOKEN
npm run smoke:convex
npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS

unset OLD_TOKEN NEW_TOKEN
```

If the smoke test fails, keep `JARVIS_SERVICE_TOKEN_PREVIOUS` configured until `.env.local` and all callers are corrected. Removing the previous token is the revocation step.

For emergency revocation, replace the current token immediately and do not configure `JARVIS_SERVICE_TOKEN_PREVIOUS`.

## Backup before destructive work

Create and verify a timestamped backup before schema migration, restore work, destructive maintenance, or an intentionally authorised production change:

```bash
cd typescript
BACKUP_FILE="backups/jarvis-$(date +%Y%m%d-%H%M%S).json"
npm run backup -- export "$BACKUP_FILE"
npm run backup -- verify "$BACKUP_FILE"
```

Verification restores into isolated temporary JSON storage and does not mutate the configured live provider.

## Development function sync

First verify the checkout and deployment identity:

```bash
cd typescript
git checkout main
git pull --ff-only origin main

grep -qx 'CONVEX_DEPLOYMENT=dev:outgoing-ram-798' .env.local
grep -qx 'CONVEX_URL=https://outgoing-ram-798.convex.cloud' .env.local
```

If either `grep` fails, stop. Do not let Convex create or select another project.

Then run the normal gates, sync once, and execute the self-cleaning development smoke test:

```bash
npm ci
npm run check
npx convex dev --once
npm run smoke:convex
```

The smoke command independently refuses any deployment whose `CONVEX_DEPLOYMENT` does not start with `dev:`.

## Production

Production commands and automation are intentionally omitted from this operational runbook.
Production remains blocked until Benny gives an explicit deployment checkpoint and the deployment
identity, backup, migration, rollback, secret-rotation, health-check, and smoke-test strategy are
reviewed first. Do not create or use a production Convex deployment, production deploy key, or
public HTTP/MCP endpoint before that approval.
