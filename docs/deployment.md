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

When `PERSISTENCE_PROVIDER=convex`, the CLI also composes an idempotent runtime-event sink. It
records only bounded route/error metadata in the `runtimeEvents` table before dispatching runtime
listeners; a failed append stops the route. This is an append foundation, not a commissioned
outbox consumer or HTTP/MCP-wide runtime composition.

## JSON provider

When `PERSISTENCE_PROVIDER` is unset or set to `json`, the maintained TypeScript runtime stores data at:

```text
typescript/data/jarvis-state.json
```

The file, its lock file, temporary writes, backups, and corrupt-file quarantine copies must not be committed.

## Environment variables

All environment variables are loaded from `typescript/.env.local` at startup. Variables marked **required** cause a hard startup failure if absent or malformed. Variables marked **optional** have safe defaults.

| Variable                                | Required / Optional                             | Default               | Purpose                                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JARVIS_SERVICE_TOKEN`                  | **Required**                                    | —                     | Current bearer token required by all authenticated HTTP and Convex operations. Must be a strong random secret; whitespace is rejected.                                                                            |
| `JARVIS_SERVICE_TOKEN_PREVIOUS`         | Optional                                        | —                     | Previous token accepted during a controlled rotation window only. Remove after rotation is complete.                                                                                                              |
| `JARVIS_TIMEZONE`                       | **Required** for Totality                       | —                     | IANA timezone string (e.g. `Australia/Melbourne`). Invalid values cause the status and Totality endpoints to return `503`.                                                                                        |
| `PERSISTENCE_PROVIDER`                  | Optional                                        | `json`                | `json` or `convex`. With `json`, data is stored in `typescript/data/jarvis-state.json`. With `convex`, `CONVEX_URL` is required.                                                                                  |
| `CONVEX_URL`                            | **Required** when `PERSISTENCE_PROVIDER=convex` | —                     | Full URL of the authorised Convex deployment (e.g. `https://outgoing-ram-798.convex.cloud`).                                                                                                                      |
| `OPENAI_API_KEY`                        | **Required** for Totality reasoning             | —                     | Server-side OpenAI API key. Never expose this in browser code, logs, issues, or chat.                                                                                                                             |
| `JARVIS_HTTP_HOST`                      | Optional                                        | `127.0.0.1`           | Listener address for the HTTP service. Change only to expose the service on a non-loopback interface.                                                                                                             |
| `JARVIS_HTTP_PORT`                      | Optional                                        | `3000`                | Listener TCP port for the HTTP service. Must be in the valid port range.                                                                                                                                          |
| `JARVIS_REMOTE_GATEWAY_ENABLED`         | Optional                                        | unset                 | Must be exactly `true` before a non-loopback HTTP bind is accepted.                                                                                                                                               |
| `JARVIS_TLS_TERMINATED`                 | Required for remote HTTP                        | unset                 | Requires an approved TLS terminator and forwarded `X-Forwarded-Proto: https`.                                                                                                                                     |
| `JARVIS_OIDC_ISSUER`                    | Required for remote HTTP                        | unset                 | HTTPS OIDC issuer URL used to validate bearer-token issuer claims.                                                                                                                                                |
| `JARVIS_OIDC_AUDIENCE`                  | Required for remote HTTP                        | unset                 | Expected OIDC access-token audience.                                                                                                                                                                              |
| `JARVIS_OIDC_JWKS_URL`                  | Required for remote HTTP                        | unset                 | HTTPS JWKS URL containing RS256 signing keys.                                                                                                                                                                     |
| `JARVIS_OIDC_SUBJECT`                   | Required for remote HTTP                        | unset                 | Exact verified OIDC `sub` claim authorised for this single-owner Jarvis instance.                                                                                                                                 |
| `JARVIS_ALLOWED_ORIGINS`                | Required for remote HTTP                        | unset                 | Comma-separated HTTPS browser origins.                                                                                                                                                                            |
| `JARVIS_MAX_REQUEST_BYTES`              | Optional                                        | `1048576`             | Remote HTTP body limit; bounded to 1024–10485760 bytes.                                                                                                                                                           |
| `JARVIS_RATE_LIMIT_MAX_REQUESTS`        | Optional                                        | `60`                  | Per-client remote HTTP request budget per window.                                                                                                                                                                 |
| `JARVIS_RATE_LIMIT_WINDOW_MS`           | Optional                                        | `60000`               | Per-client remote HTTP rate-limit window.                                                                                                                                                                         |
| `JARVIS_TOTALITY_MAX_REQUEST_BYTES`     | Optional                                        | `262144`              | Aggregate Totality request-size ceiling before provider dispatch.                                                                                                                                                 |
| `JARVIS_TOTALITY_MAX_INPUT_TOKENS`      | Optional                                        | `32768`               | Estimated aggregate input-token ceiling per Totality request.                                                                                                                                                     |
| `JARVIS_TOTALITY_MAX_CONCURRENT`        | Optional                                        | `4`                   | Maximum simultaneous Totality provider calls in one process.                                                                                                                                                      |
| `JARVIS_TOTALITY_COST_UNITS_PER_WINDOW` | Optional                                        | `100000`              | Rolling aggregate provider-cost reservation budget; each request reserves estimated input plus the fixed output ceiling.                                                                                          |
| `JARVIS_TOTALITY_MAX_OUTPUT_TOKENS`     | Optional                                        | `4096`                | Hard output-token ceiling sent to the configured provider.                                                                                                                                                        |
| `JARVIS_TOTALITY_QUOTA_WINDOW_MS`       | Optional                                        | `3600000`             | Rolling Totality provider-cost quota window in milliseconds.                                                                                                                                                      |
| `JARVIS_SOURCE_VERSION`                 | Optional                                        | `development`         | Git SHA or version string embedded in health and status responses for diagnostics.                                                                                                                                |
| `JARVIS_DEPLOYMENT_VERSION`             | Optional                                        | —                     | Deployment identifier (e.g. `dev:outgoing-ram-798`) embedded in status responses.                                                                                                                                 |
| `CONVEX_DEPLOYMENT`                     | Set by Convex                                   | —                     | Set automatically by `npx convex dev` when the project is linked. Required by the Convex SDK and the smoke test (`npm run smoke:convex`). Do not set manually.                                                    |
| `JARVIS_RECONCILIATION_ENABLED`         | Optional                                        | `false`               | Requests the external reconciliation scheduler only when exactly `true`. The maintained runtimes reject enabled startup until at least one provider adapter is explicitly composed. All other values fail closed. |
| `JARVIS_RECONCILIATION_WORKER_ID`       | Optional                                        | Generated per process | Safe operator-visible worker identity; 1–128 letters, digits, dots, underscores, colons, or hyphens.                                                                                                              |
| `JARVIS_RECONCILIATION_LEASE_MS`        | Optional                                        | `30000`               | Positive claim lease duration in milliseconds.                                                                                                                                                                    |
| `JARVIS_RECONCILIATION_INTERVAL_MS`     | Optional                                        | `5000`                | Positive delay between bounded reconciliation cycles.                                                                                                                                                             |
| `JARVIS_RECONCILIATION_BATCH_SIZE`      | Optional                                        | `10`                  | Maximum records processed per cycle; 1–100.                                                                                                                                                                       |
| `JARVIS_RECONCILIATION_MAX_ATTEMPTS`    | Optional                                        | `5`                   | Maximum reconciliation attempts before escalation; 1–100.                                                                                                                                                         |
| `JARVIS_RECONCILIATION_BASE_RETRY_MS`   | Optional                                        | `1000`                | Positive base retry delay.                                                                                                                                                                                        |
| `JARVIS_RECONCILIATION_MAX_RETRY_MS`    | Optional                                        | `60000`               | Positive maximum retry delay, not below the base delay.                                                                                                                                                           |
| `JARVIS_RECONCILIATION_FRESHNESS_MS`    | Optional                                        | `60000`               | Maximum age of the last successful reconciliation cycle before authenticated status reports degraded; positive integer.                                                                                           |

## Reconciliation runtime

Reconciliation is disabled by default and performs no Convex construction, claim, or polling work.

When Outlook is explicitly enabled and its delegated OAuth configuration is valid, the maintained
HTTP and controlled preview compositions attach the Outlook provider. The existing Convex
reconciliation worker is constructed only when `JARVIS_RECONCILIATION_ENABLED=true` and that
provider path is valid. When Outlook is disabled, no provider or reconciliation worker is
constructed; all other configurations fail closed before a listener opens or Convex work begins.

The Outlook runtime requires an application ID, mailbox, and absolute owner-only refresh-token
file path:

```text
JARVIS_OUTLOOK_ENABLED=true
JARVIS_OUTLOOK_CLIENT_ID=<Microsoft app ID>
JARVIS_OUTLOOK_MAILBOX=<mailbox>
JARVIS_OUTLOOK_REFRESH_TOKEN_FILE=/absolute/private/path
JARVIS_RECONCILIATION_ENABLED=true
```

The secure token file is rotated atomically and is not a GitHub secret or a checked-in artifact.
The full delegated OAuth, scope, file-permission, and immutable-ID rules are in
`docs/runbooks/outlook-delegated-oauth.md`.

The `microsoft-graph-mail-v1` adapter uses immutable Outlook message IDs and a narrow Microsoft
Graph boundary. The send provider creates a draft, persists its immutable message ID before
sending, and records provider references for reconciliation. A Graph `202 Accepted` response is
not terminal evidence that message processing completed.

No live Microsoft credential, draft/send run, or production activation is evidenced by the current
commissioning record. Outlook remains a separately gated development capability; production
deployment and public email sending remain unauthorised.

When an adapter-bearing runtime is supplied, the host uses the existing Convex reconciliation
store, lease rules, worker, and bounded scheduler. Authenticated `GET /api/v1/status` reports
process-local reconciliation state and redacted cycle timing. Public `GET /healthz` remains
liveness-only. Shutdown stops new claims, waits for active reconciliation, then closes MCP and
HTTP resources.

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

The MCP service must retain its loopback default:

```text
JARVIS_MCP_HOST=127.0.0.1
```

HTTP may use a non-loopback bind only with the repository's explicit remote gateway variables:
OIDC bearer verification, TLS termination, HTTPS origin policy, request-size and rate limits, and
an approved hosting/deployment review. These variables create a fail-closed boundary; they do not
constitute production commissioning or authorise public exposure.

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

## Immutable quote PDF renderer

Jarvis includes a deterministic in-memory renderer for client-ready A4 PDFs from authoritative
finalized quote revisions. The renderer requires the finalized revision fingerprint plus explicit
issuer and client presentation details. It returns exact bytes, media type, safe filename, byte
length, and a `quote-pdf:v1:sha256` digest.

Quote finalisation now runs through a Convex Node action. The action stamps the server time, derives
the final revision fingerprint, renders and stores the PDF Blob, then atomically commits the
finalised revision and immutable `quotePdfArtifacts` metadata. The legacy mutation fails closed.
Owner-scoped retrieval returns metadata plus a signed storage URL. Development cleanup removes the
Blob and metadata with the quote.

This commissions the durable artefact boundary only. It does not configure Outlook, create a draft,
send email, expose an MCP send tool, or deploy production. A later Outlook provider may attach only
the stored immutable artefact after the separate credential, live-send and deployment approvals.

## Development PostHog runtime observability

PostHog capture is disabled unless all three development gates are explicit:

```text
JARVIS_ENVIRONMENT=development
JARVIS_POSTHOG_ENABLED=true
POSTHOG_PROJECT_API_KEY=phc_<development-project-key>
```

The optional `POSTHOG_HOST` defaults to `https://us.i.posthog.com`. It must be HTTPS with no embedded credentials, query string or fragment. `POSTHOG_TIMEOUT_MS` is optional and must be 25–2000 ms; the default is 250 ms. Invalid configuration fails closed to inert telemetry. The project key is used only for the PostHog capture transport and is never included in event properties.

The native adapter emits only the governed `jarvis.operator_action`, `jarvis.tool_outcome`, `jarvis.boundary_latency`, `jarvis.runtime_failure`, and bounded `jarvis.usage` events. Properties are limited to development environment, fixed distinct ID, maintained boundary, operation, allowlisted outcome/method/status, bounded duration, bounded count, and failure kind. Prompts, tokens, credentials, message bodies, customer quote data and raw provider payloads are not captured. Transport is best-effort, asynchronous and timeout-bounded; a PostHog failure cannot delay or fail a business operation.

Later development commissioning requires an explicit authorised development credential, deliberate operator/tool/latency exercises, inspection of ingested properties and retention, and evidence that no customer content or secret entered the project. This change does not commission PostHog, add credentials, authorise production, or permit production deployment.
