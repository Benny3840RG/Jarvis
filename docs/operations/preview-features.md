# Preview and experimental features

This document defines the boundary between Jarvis's stable operational baseline and any preview or experimental features.

## Definition

A **preview feature** is any capability that:

- is not yet included in the stable commissioning workflow,
- has not completed the full verification gate (`npm run check`) at the time of merge,
- depends on infrastructure, credentials, or runtime behaviour not part of the authorised development stack,
- or is explicitly marked as a draft or experimental in its PR description.

The ChatGPT App (MCP) adapter was the most recent preview feature. It has since
graduated (see [Current preview status](#current-preview-status)); no preview
feature is currently open.

## Isolation policy

Preview features must be isolated from the operational baseline at every level:

### Source code

- Preview source code lives under `typescript/src/preview/` or `typescript/src/mcp/`.
- Preview source must not be imported by stable production modules (`src/http/`, `src/cli.ts`, `src/index.ts`).
- Preview modules may import stable modules.

### Tests

- Preview-specific tests live in `typescript/tests/` and follow the same naming conventions, but must not break the stable test suite.
- The full `npm run check` must pass on `main` with and without preview modules present.

### Workflows

- Preview commissioning runs are handled by a dedicated workflow (`.github/workflows/development-preview-commissioning.yml`) that is separate from the main development commissioning workflow.
- Preview workflows are gated on `main` and require explicit dispatch confirmation (`PREVIEW DEV`).
- The main commissioning workflow (`development-commissioning.yml`) does not exercise preview code paths.

### Pull requests

- Preview work lives in a draft PR targeting `main`.
- A draft PR must have **all CI checks passing** before it is promoted from draft to open.
- Promoting a draft PR to ready-for-review implicitly declares that the preview feature is stable enough for the operational baseline.

## Graduation criteria

A preview feature may graduate to the stable baseline when:

1. All TypeScript type checks pass (`npm run type-check`).
2. Lint and format checks pass (`npm run lint`, `npm run format:check`).
3. The OpenAPI contract validates cleanly (`npm run openapi:lint`).
4. The full test suite passes (`npm run test`).
5. The feature has been exercised by a dedicated smoke test or commissioning stage.
6. The PR is no longer a draft and has received a review.

## Preview smoke coverage

Criterion 5 for the ChatGPT App / MCP adapter is satisfied by the development
paddock readiness probe. The acceptance logic that `npm run paddock` runs against
a live preview — required MCP tools present, the operator-console dashboard
resource valid, and the dashboard snapshot matching the commissioned Convex
deployment — is factored into `typescript/src/preview/paddockProbe.ts` and covered
by `typescript/tests/paddockProbe.test.ts`.

That test stands up the real in-process MCP server against a mocked Jarvis HTTP
API, so the readiness contract runs unattended inside `npm run check` (and CI)
without an authorised Convex deployment or OpenAI credentials. It exercises both
the healthy end-to-end path and the fail-closed branches (missing tool, malformed
or duplicated dashboard resource, error tool result, and provider-state drift from
the commissioned deployment).

## Current preview status

| Feature | Branch | PR | CI status | Notes |
| --- | --- | --- | --- | --- |
| ChatGPT App / MCP adapter | `feat/chatgpt-preview` (merged) | [#63](https://github.com/Benny3840/Jarvis/pull/63) (merged) | Green | Graduated — all criteria met |

The ChatGPT App / MCP adapter has **graduated** to the supported surface. Its
graduation criteria are satisfied on `main`:

1. Type checks pass (`npm run type-check`).
2. Lint and format checks pass (`npm run lint`, `npm run format:check`).
3. The OpenAPI contract validates cleanly (`npm run openapi:lint`).
4. The full test suite passes (`npm run test`).
5. The readiness contract is exercised by the paddock probe smoke test
   (`tests/paddockProbe.test.ts`, run inside `npm run check` and CI) and the
   `smoke:mcp` command, and the MCP tool surface is held to the OpenAPI contract
   by `tests/mcpOperationContract.test.ts`.
6. PR [#63](https://github.com/Benny3840/Jarvis/pull/63) is merged (no longer a
   draft) and was reviewed and merged by the owner.

The adapter remains a **separately launched, loopback-only service** (`npm run
start:mcp` / `npm run start:preview` / `npm run paddock`). Graduation means it is
supported and no longer experimental; it does not change the isolation policy
above — the MCP and preview modules are still not imported by the stable HTTP
CLI baseline (`src/http/`, `src/cli.ts`, `src/index.ts`).
