# Jarvis ownership and concurrency

Status: accepted

## Decision

Jarvis v0.x is a single-account, single-operator assistant. The stable logical owner is `jarvis-cli`; the current service token authenticates a trusted Jarvis client to that owner. The token is a machine credential, not a user identity, and must not be used as the basis for multi-user permissions.

Multiple Jarvis processes or devices may access the same data when the Convex provider is selected. Convex remains authoritative, each public query and mutation validates the service token, and every record is filtered or checked against the owner ID on the server.

The local JSON provider is a local fallback and recovery provider. It uses atomic replacement for complete documents and an exclusive adjacent lock file for mutations. A mutation must acquire the lock, re-read the latest document, apply one change, write atomically, and release the lock. Reads do not take the lock because atomic replacement guarantees a complete old or new document. This permits several local processes to remain open while ensuring only one JSON writer changes the file at a time.

Jarvis will not silently fall back from Convex to JSON. Provider selection is explicit and startup fails closed when the selected provider is unavailable or misconfigured.

## Consequences

- No OIDC or workspace membership model is required for the current product phase.
- Adding a second human account requires a new authentication and authorisation design, owner migration, indexes, and tenant-isolation tests before exposure.
- Convex is the preferred provider for multiple devices or machines.
- JSON mutations are serialised on one machine and fail with an actionable timeout rather than risking a lost update.
- A crashed local writer may leave a lock file; Jarvis may reclaim it only when the recorded process is no longer alive.
- Backup archives remain provider-neutral and retain one logical owner’s data.

## Revisit when

Revisit this decision before any shared login, hosted public UI, delegated access, team workspace, or production multi-user deployment.
