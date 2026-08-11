# Local operator HTTP API

Jarvis exposes a localhost-first NestJS/Fastify system boundary alongside the maintained CLI.
This stage implements only the operations whose runtime behaviour is complete:

| Method           | Path                             | Authentication | Purpose                                                     |
| ---------------- | -------------------------------- | -------------- | ----------------------------------------------------------- |
| GET              | `/healthz`                       | Public         | Process liveness only; never reads persistence.             |
| GET              | `/api/v1/help`                   | Bearer token   | Lists only operations implemented by the running adapter.   |
| GET              | `/api/v1/status`                 | Bearer token   | Checks persistence, timezone, layer readiness, and Z-State. |
| GET              | `/api/v1/reminders`              | ******         | Lists durable reminders.                                    |
| POST             | `/api/v1/reminders`              | ******         | Creates a durable reminder.                                 |
| GET/PATCH/DELETE | `/api/v1/reminders/{reminderId}` | ******         | Reads, updates, or removes one reminder.                    |

The adapter also implements `/api/v1/tasks` (including completion), `/api/v1/totality/reason`, and
the project-scoped memory-change-set and tool-action proposal routes. Tool-action approval changes
proposal state only; there is intentionally no HTTP execution route in this stage.

The task and Totality routes are also implemented by the maintained adapter; proposal routes are
review-only and approval never executes a tool. The complete implementation target remains
[`../../openapi/jarvis.openapi.json`](../../openapi/jarvis.openapi.json). Operations not listed
above are not yet HTTP routes. Reminder creation requires an `Idempotency-Key`; due input preserves
the exact `text` and optionally normalizes it using the supplied `timezone`.

## Configuration

The service reads `.env.local` before startup. Keep that file untracked and private.

```text
JARVIS_SERVICE_TOKEN=<existing strong Jarvis service token>
JARVIS_TIMEZONE=Australia/Melbourne
PERSISTENCE_PROVIDER=json
JARVIS_SOURCE_VERSION=<build commit or immutable source identifier>
```

`PERSISTENCE_PROVIDER` defaults to `json`; `convex` keeps the existing `CONVEX_URL` and service
token requirements. `JARVIS_SERVICE_TOKEN_PREVIOUS` is accepted only while a current token is
also configured, preserving the documented rotation overlap and failing closed otherwise.

`JARVIS_APPROVAL_TOKEN` (with optional `JARVIS_APPROVAL_TOKEN_PREVIOUS` during rotation) is a
second, separately held secret required by `POST .../tool-actions/{actionId}/approve` in addition
to the Bearer service token — see [tool-action-approval.md](tool-action-approval.md). It exists
so that possessing the service token, which any caller staging a proposal necessarily does, is not
by itself sufficient to approve one.

When `PERSISTENCE_PROVIDER=convex`, set the same approval secret in the Convex deployment as
`JARVIS_APPROVAL_TOKEN`. Convex independently verifies it on its public `approve` and `revoke`
mutations, so a client holding only `JARVIS_SERVICE_TOKEN` cannot bypass the HTTP boundary.
Quote-delivery mutations additionally require a separate `JARVIS_DELIVERY_RUNTIME_TOKEN` (and
optional `JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS` while rotating) in both the delivery runtime and
the Convex deployment. It must not equal the service token; it authorises delivery-ledger writes,
not human approval.

Optional transport values are:

| Variable                                      | Default     | Meaning                                                                             |
| --------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `JARVIS_HTTP_HOST`                            | `127.0.0.1` | Explicit bind host.                                                                 |
| `JARVIS_HTTP_PORT`                            | `3000`      | TCP port from 1 through 65535.                                                      |
| `JARVIS_DEPLOYMENT_VERSION`                   | unset       | Safe provider deployment/contract identifier for status.                            |
| `JARVIS_REMOTE_GATEWAY_ENABLED`               | unset       | Must be exactly `true` before a non-loopback HTTP bind is accepted.                 |
| `JARVIS_TLS_TERMINATED`                       | unset       | Must be exactly `true`; the approved proxy must forward `X-Forwarded-Proto: https`. |
| `JARVIS_OIDC_ISSUER` / `JARVIS_OIDC_AUDIENCE` | unset       | Required together for remote HTTP bearer-token verification.                        |
| `JARVIS_OIDC_JWKS_URL`                        | unset       | Explicit HTTPS JWKS endpoint for RS256 verification.                                |
| `JARVIS_OIDC_SUBJECT`                         | unset       | Exact verified OIDC `sub` claim authorised for the single Jarvis owner.             |
| `JARVIS_ALLOWED_ORIGINS`                      | unset       | Comma-separated HTTPS browser origins accepted by the remote gateway.               |
| `JARVIS_MAX_REQUEST_BYTES`                    | 1048576     | Remote request body limit, bounded to 1024–10485760 bytes.                          |
| `JARVIS_RATE_LIMIT_MAX_REQUESTS`              | 60          | Per-client remote request budget per window.                                        |
| `JARVIS_RATE_LIMIT_WINDOW_MS`                 | 60000       | Remote rate-limit window in milliseconds.                                           |
| `JARVIS_TOTALITY_MAX_REQUEST_BYTES`           | 262144      | Aggregate Totality request-size ceiling before provider dispatch.                   |
| `JARVIS_TOTALITY_MAX_INPUT_TOKENS`            | 32768       | Estimated aggregate input-token ceiling per Totality request.                       |
| `JARVIS_TOTALITY_MAX_CONCURRENT`              | 4           | Maximum simultaneous Totality provider calls in one process.                        |
| `JARVIS_TOTALITY_COST_UNITS_PER_WINDOW`       | 100000      | Rolling aggregate provider-cost reservation budget.                                 |
| `JARVIS_TOTALITY_MAX_OUTPUT_TOKENS`           | 4096        | Hard output-token ceiling sent to the provider.                                     |
| `JARVIS_TOTALITY_QUOTA_WINDOW_MS`             | 3600000     | Rolling provider-cost quota window in milliseconds.                                 |

`JARVIS_SOURCE_VERSION` defaults to `development` for local work. Release automation should set
it to the immutable source commit.

## Run and inspect

```bash
cd typescript
nvm use
npm ci
npm run start:http
```

Liveness does not need a credential:

```bash
curl --silent --show-error http://127.0.0.1:3000/healthz
```

For an authenticated status check without placing the token in the command arguments, load the
local environment and pass curl configuration on standard input:

```bash
set -a
. ./.env.local
set +a

curl --silent --show-error --config - <<EOF
url = "http://127.0.0.1:3000/api/v1/status"
header = "Authorization: Bearer $JARVIS_SERVICE_TOKEN"
EOF
```

Every response includes `X-Request-Id`, `Cache-Control: no-store`, and
`X-Content-Type-Options: nosniff`. A caller may supply an opaque `X-Request-Id` containing 8 to
128 safe characters; Jarvis generates one when the value is absent or unsafe.

Failures use `application/problem+json` with a stable type, safe detail, request path, and request
ID. Supplied credentials, configured credentials, persistence exception text, query strings, and
internal stack details are never included.

## Status semantics

A successful status read checks state, tasks, and reminders through the selected persistence
provider before returning `reachability: ok` and `schemaCompatibility: compatible`. It also returns
a process-local `reconciliation` snapshot. The snapshot is `disabled` unless reconciliation is
explicitly enabled; enabled snapshots may include the safe worker ID, cycle timestamps, bounded
processed count, and the stable `reconciliation-loop-failed` code. Tokens, record IDs, provider
references, raw exceptions, and stacks are never returned. JSON reports
`authentication: not-required`; Convex reports `authentication: ok` only after its authenticated
reads succeed.

Layer readiness is deliberately independent of process health. The maintained storage runtime can
be healthy while prototype Z-State layers remain `partial` or `inactive`; Z-State therefore stays
`disabled` until the stabilisation, proposal-safety, and reliability requirements are implemented.
The reliability layer records the status read's persistence probe using a bounded circuit breaker.
A passing probe reports `partial` because recovery and external dependency probes are not yet
commissioned; repeated failures open the circuit and fail the status read closed. Raw provider
errors are never included in the layer reason or response.
When reconciliation is enabled, the top-level status is also `degraded` until the worker is running
and has produced a fresh successful cycle with no released or escalated work. A stopped, failed,
stale, or never-completed worker cannot be reported as healthy. `/healthz` remains liveness-only.

Status also reports `integrations`: an array of evidence-backed integration-commissioning line items
(`{name, status: "commissioned" | "not-commissioned", reason?}`), never a percentage and never inferred
from an environment variable simply being set. See
[Operations Inbox, Activity Timeline & Integration Health](./operations-inbox.md) for the full source-of-
truth map, including the read-only Operations Inbox (`GET /api/v1/operations/inbox`) and Activity Timeline
(`GET /api/v1/operations/activity`) endpoints.

## Exposure boundary

The default loopback bind remains the supported development posture. A non-loopback HTTP bind is
accepted only when the remote gateway is explicitly enabled with TLS termination, an HTTPS OIDC
issuer/audience/JWKS configuration, an allowlisted HTTPS origin set, bounded request size, and a
per-client rate budget. The proxy must terminate TLS and send `X-Forwarded-Proto: https`; the
application does not expose a plaintext remote listener.

This repository-side boundary does not commission a hosting provider, create OIDC credentials, or
approve public exposure. MCP remains loopback-only. The service token must remain server-side and
must never enter model input, widget state, URLs, logs, or tool arguments.
