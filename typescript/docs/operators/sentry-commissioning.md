# Sentry development commissioning

Issue #303 remains open until Sentry independently shows the expected events and
proven alert behaviour. This command prepares a bounded transport observation;
it cannot establish provider retention, alert activation or mission completion.

Use an approved development project and install its DSN through the environment
or ignored `.env.local`, without copying credentials into terminal arguments,
issues or logs. Set both `JARVIS_ENVIRONMENT=development` and
`SENTRY_ENVIRONMENT=development`. `SENTRY_DSN` must be present. The command refuses
a dirty checkout and derives its release from the actual source repository's
HEAD, ignoring any release override. Production use is outside this tool's scope.

From `typescript/`, after local verification and the required development
authorization:

```sh
npm run commission:sentry
```

The command reuses the existing inert commissioning app without opening a
listener or connecting a persistence provider. The real API client requests
`GET /api/v1/status` in-process. The app intentionally has no service-auth
configuration, so its existing guard returns 503 before a domain handler runs.
The API client emits one error and one failure/latency transaction through the
normal Sentry runtime. PostHog is disabled for this probe. No task, quote, message,
approval, execution-intent or other business record is created.

The JSON receipt includes source SHA, expected local 503, event IDs/types and:

| Transport observation | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `ACCEPTED`            | Envelope transport returned successfully; Sentry retention is unproven. |
| `REJECTED`            | Sentry returned a non-success HTTP response; its status is included.    |
| `INDETERMINATE`       | Timeout or transport error left acceptance unknown.                     |

The command exits nonzero if any delivery is rejected or indeterminate. It never
retries an envelope. A response arriving after the bounded observation does not
turn indeterminate into accepted. `providerEvidence` and `alertEvidence` remain
`NOT_PROVEN` even when both transports accept the envelopes. No raw provider
error, event payload, DSN or token is printed.

Before a further probe after an uncertain result, query Sentry by the recorded
event IDs, source release and development environment. Record independently
observed error and transaction properties, redaction/data minimisation checks,
and the separate alert-rule configuration and triggered alert evidence on #303.
Do not infer those results from the command's exit code. A latency transaction
does not itself prove a latency threshold alert fired.

Current live blocker: authenticated Sentry project/DSN/query access is absent
from this implementation session. The command was tested with synthetic
transport responses only. Benny's production approval, existing Jarvis policy
and ΩΣ completion remain separate boundaries.
