# Immutable Safety Category Binding

## Authority

The OpenAPI architecture metadata defines six immutable safety categories:

1. `domain`
2. `cross-domain`
3. `memory`
4. `reliability`
5. `proposal`
6. `tool-action`

The canonical source is `typescript/openapi/jarvis.openapi.json` under
`x-jarvis-architecture.immutableSafetyCategories`. The runtime must not
silently reduce or rename this set.

## Runtime contract

`typescript/src/safety/safetyBinder.ts` exposes a frozen, fail-closed
binding record. Every binding has:

- a lifecycle phase;
- one decision for each of the six categories;
- a stable `pass` or `blocked` status;
- redacted, deterministic reason strings.

The binder rejects missing evidence for the category affected by the phase or
effect. Mutating and external-effect phases additionally require reliability
evidence, idempotency, correlation, and recovery capability. Tool phases
require allowlisting, valid state, authority, and approval evidence. Credential-
like payload fields are rejected before tool execution.

## Boundaries

The maintained runtime currently binds the contract at two effect-relevant
seams:

- Totality reasoning validation (`runtime/validation.ts`);
- governed tool execution before schema execution or provider invocation
  (`actions/toolExecution.ts`).

The existing approval, idempotency, timeout, provider-reference, and
reconciliation checks remain authoritative. The binder supplements those
controls; it does not authorize an action and it never bypasses them.

## Evidence status

This slice provides in-process category decisions and stable blocked receipts.
Convex lifecycle records do not yet persist the complete category-decision
object for every proposal, approval, revoke, execution, and reconciliation
transition. The system status layer reports that boundary as partial. Closing
that persistence attachment is the next safety slice; no production-complete
claim should be made until its schema, migration, and restart tests exist.
