# Public evidence projections

Convex owner reads must not reveal another worker's lease capability. Public
reconciliation reads and ordinary mutation responses omit `leaseOwner` and
`leaseToken`. The authenticated claim response still returns the claimed lease
needed by that worker; lease checks, expiry, fencing and persisted history are
unchanged. `leaseExpiresAt` remains useful operational metadata.

Development `canonicalRequestFingerprint` is canonical request JSON, not a hash;
it can contain a submitted lease. Public event reads, commit/replay responses and
model-invocation responses omit it. Rejection audit readers omit the same field
from the known `development.transition.rejected` payload. Stored fingerprints
remain exact for private replay validation and historical export; projections
never patch durable records or grant completion authority.

The existing HTTP contract already excludes these private fields. Convex callers
that need a worker lease must acquire their own claim; they cannot recover it from
operator listings. Privileged backup capture is a separate boundary and must use
both existing service and approval credentials, preserve historical truth, and
make recovered capabilities inert before exposing restored normal stores.
