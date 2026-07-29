# Console Manufact Initialise Repair Design

## Problem

Manufact deployment `0df3be3d-6202-4955-bf38-be7c9180b69a` built successfully from `main` at `8d671a69b7fd4335c5300197f2d3230bb72c18f5`, then failed its MCP verification. Runtime evidence shows four unauthenticated `initialize` requests returning HTTP 503. The active production deployment therefore remained the older 24 July build.

The custom Console gateway middleware currently applies bearer-token enforcement to every `/mcp` request. When `CONSOLE_GATEWAY_TOKEN` is absent it returns 503 before the MCP runtime can answer `initialize`; when the token is present Manufact's unauthenticated verification would instead receive 401. Either result prevents a healthy deployment.

## Approved behaviour

- Permit an unauthenticated request through the custom gateway only when it is a valid JSON-RPC MCP `initialize` request on the gated MCP route.
- Continue to require a valid bearer token for every tool call, resource read, prompt operation, session continuation and SSE route.
- Continue to return 503 for protected operations when `CONSOLE_GATEWAY_TOKEN` is missing.
- Continue to return 401 for protected operations when the token is configured but absent or wrong.
- Compare bearer secrets in constant time and do not log them.
- Do not weaken the Convex owner/service-token boundary.
- Do not invent telemetry or change the HUD data contract.

The unauthenticated handshake may expose normal MCP capability metadata but no Jarvis business data and no side effect. This is the minimum compatibility exception needed for Manufact's deployment verifier.

## Design

Extract gateway decisions into `typescript/jarvis-console-01/gatewayAuth.ts`. The pure function receives the configured token, candidate token and parsed JSON-RPC method. It returns one of `allow-initialize`, `allow-token`, `missing-configuration` or `unauthorized`.

`index.ts` remains responsible for HTTP parsing. On `/mcp` it clones a JSON POST request only far enough to identify a top-level string `method`. It passes that value to the pure decision function. Non-JSON, malformed, batched, SSE and non-MCP requests receive no initialize exception.

## Verification

Automated tests must prove:

1. `initialize` is allowed with no configured token.
2. non-initialize requests fail closed when configuration is missing.
3. correct bearer credentials allow protected requests.
4. missing, wrong and prefix/suffix credentials remain unauthorized.
5. no Console, Jarvis or Convex secret value is present in test output or committed fixtures.

The Console package build, type-check, audit and repository-wide CI must pass before merge. A later production redeploy must show a successful MCP initialize check before the old deployment is replaced.
