# Console gateway blank-token hardening review

## Security review

A whitespace-only `CONSOLE_GATEWAY_TOKEN` should fail closed as missing gateway configuration. Treating it as a configured token causes every protected non-initialize request to look like an invalid credential instead of surfacing operator misconfiguration.

## Owner isolation

No owner-scoped Convex access changes. This slice affects only gateway admission before any Convex bridge call.

## External effects

No external effect path is added or changed. No ToolAction execution, Outlook, quote, or reconciliation path is touched.

## Compatibility

Exact matching is preserved for every non-blank configured token. The implementation only uses `trim()` for the configuration-existence check; it does not trim candidate tokens or alter the constant-time digest comparison.
