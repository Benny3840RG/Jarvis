# Local operator HTTP API

Jarvis exposes a localhost-first NestJS/Fastify system boundary alongside the maintained CLI.
This stage implements only the system operations whose runtime behaviour is complete:

| Method           | Path                             | Authentication | Purpose                                                     |
| ---------------- | -------------------------------- | -------------- | ----------------------------------------------------------- |
| GET              | `/healthz`                       | Public         | Process liveness only; never reads persistence.             |
| GET              | `/api/v1/help`                   | Bearer token   | Lists only operations implemented by the running adapter.   |
| GET              | `/api/v1/status`                 | Bearer token   | Checks persistence, timezone, layer readiness, and Z-State. |
| GET              | `/api/v1/reminders`              | ******         | Lists durable reminders.                                    |
| POST             | `/api/v1/reminders`              | ******         | Creates a durable reminder.                                 |
| GET/PATCH/DELETE | `/api/v1/reminders/{reminderId}` | ******         | Reads, updates, or removes one reminder.                    |

The complete implementation target remains
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

Optional transport values are:

| Variable                    | Default     | Meaning                                                  |
| --------------------------- | ----------- | -------------------------------------------------------- |
| `JARVIS_HTTP_HOST`          | `127.0.0.1` | Explicit bind host.                                      |
| `JARVIS_HTTP_PORT`          | `3000`      | TCP port from 1 through 65535.                           |
| `JARVIS_DEPLOYMENT_VERSION` | unset       | Safe provider deployment/contract identifier for status. |

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
provider before returning `reachability: ok` and `schemaCompatibility: compatible`. JSON reports
`authentication: not-required`; Convex reports `authentication: ok` only after its authenticated
reads succeed.

Layer readiness is deliberately independent of process health. The maintained storage runtime can
be healthy while prototype Z-State layers remain `partial` or `inactive`; Z-State therefore stays
`disabled` until the stabilisation, proposal-safety, and reliability requirements are implemented.

## Exposure boundary

The default loopback bind is intentional. Do not bind this service to a remote interface or put it
on the public internet as a substitute for user authentication. Remote MCP or multi-user exposure
requires the planned OAuth 2.1 boundary, TLS, origin policy, and deployment review. The service
token must remain server-side and must never enter model input, widget state, URLs, logs, or tool
arguments.
