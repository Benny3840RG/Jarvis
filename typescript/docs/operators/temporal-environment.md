# Temporal environment readiness

Jarvis has one resolver for the Temporal PASS preview client, worker and orchestrator.

## Configuration

The runtime accepts:

- `TEMPORAL_ADDRESS` — Temporal frontend address. Existing local default: `localhost:7233`.
- `TEMPORAL_NAMESPACE` — namespace. Existing local default: `default`.
- `JARVIS_TEMPORAL_REQUIRED` — optional fail-closed switch. Accepted true values: `1`, `true`, `yes`, `on`; false values: `0`, `false`, `no`, `off`.

An explicitly supplied blank address, namespace or invalid required value is a configuration error.

## Readiness check

From `typescript/`:

```bash
npm run temporal:readiness
```

The command loads `.env.local`, binds its receipt to the exact current git commit and performs a read-only Temporal client connection.

The JSON receipt deliberately omits the actual address and namespace. It reports only whether each value came from the environment or the local default.

Lifecycle meanings are strict:

- `absent`: no explicit Temporal configuration and the local default could not be reached.
- `configured`: an explicit environment is present but a client connection could not be established.
- `reachable`: a client connection succeeded.
- `commissioned`: **never inferred by this probe**. A reachable server is not proof of replay, worker-version rollback, governed effects, production approval or any other commissioning gate.

The command exits non-zero when Temporal is not reachable. If `JARVIS_TEMPORAL_REQUIRED=1`, a failed connection is a fail-closed error with transport details redacted.

## Evidence boundary

A readiness receipt contains the exact 40-hex source commit SHA and the redacted readiness state. It can support later PR-B Temporal work, but it does not itself satisfy the deferred replay or v1 → v2 → rollback proof.

Benny-only merge/deployment authority and the existing Temporal/ΩΣ authority boundary are unchanged.
