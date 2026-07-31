# Console gateway blank-token hardening

## Objective

Treat a blank or whitespace-only `CONSOLE_GATEWAY_TOKEN` as missing gateway configuration rather than as a configured secret that can never be matched by a normal bearer token.

## Facts

- Console 01 gates `/mcp` and `/sse` through `decideGatewayAccess` in `typescript/jarvis-console-01/gatewayAuth.ts`.
- The middleware already distinguishes missing configuration, missing bearer token, and invalid bearer token in `typescript/jarvis-console-01/index.ts`.
- Before this slice, `decideGatewayAccess` used `if (!configuredToken)`, so `" "`, `"\t"`, or `"\n"` were treated as configured values rather than missing configuration.

## Assumptions

- A whitespace-only environment secret is operator misconfiguration, not a deliberately valid gateway token.
- Trimming is used only to classify blank configuration. Exact token matching remains unchanged for non-blank configured values.

## Unknowns

- Local full-suite execution is unavailable through this connector-only workflow. Remote CI is the verification source for type-check and tests.

## Boundary

Changed files:

- `typescript/jarvis-console-01/gatewayAuth.ts`
- `typescript/jarvis-console-01/tests/gateway-auth.test.ts`

Excluded files/subsystems:

- ToolAction consent lifecycle
- Quote send/finalize surfaces
- Reconciliation workers/read models
- HUD layout and telemetry display
- Production deployment

## Acceptance criteria

- Blank and whitespace-only configured gateway tokens return `missing-configuration`.
- Valid non-blank token matching remains exact.
- Invalid/missing bearer behavior remains unchanged.
- Gateway auth tests pass in CI.
- TypeScript checks pass in CI.
