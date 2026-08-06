# Reliability layer

Jarvis now has a maintained reliability boundary around the authenticated system-status persistence
probe.

The controller:

- runs the real persistence readiness reads through one bounded probe;
- records only stable outcome metadata and probe timestamps;
- opens a dependency circuit after repeated failures;
- blocks calls while the circuit is open;
- permits one half-open recovery probe after the cooldown; and
- closes the circuit after a successful recovery probe.

`GET /api/v1/status` reports the resulting layer state. A passing persistence probe is `partial`,
not `ready`, because recovery orchestration and external dependency probes are not commissioned yet.
Repeated failures make the circuit `blocked` internally and the status operation returns the existing
redacted `503 persistence-unavailable` problem. No provider exception text, token, stack, or response
body is retained in reliability evidence.

When reconciliation is enabled, the same status endpoint reports top-level `degraded` until the
worker is running and has produced a fresh successful cycle. Released or escalated work, a failed
loop, a stopped worker, a worker with no completed cycle, and a stale last-success timestamp all fail
that readiness condition. `/healthz` remains process liveness only.

The implementation is deliberately provider-neutral. It does not invent a live Convex deployment,
start a background retry loop, or count the separately reported reconciliation worker as healthy.
Those remain commissioning work requiring the real deployment and provider configuration.
