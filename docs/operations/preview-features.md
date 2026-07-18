# Preview and experimental features

This document defines the boundary between Jarvis's stable operational baseline and any preview or experimental features.

## Definition

A **preview feature** is any capability that:

- is not yet included in the stable commissioning workflow,
- has not completed the full verification gate (`npm run check`) at the time of merge,
- depends on infrastructure, credentials, or runtime behaviour not part of the authorised development stack,
- or is explicitly marked as a draft or experimental in its PR description.

The current preview feature is the **ChatGPT App (MCP) adapter** tracked in draft PR #63.

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

## Current preview status

| Feature | Branch | PR | CI status | Notes |
| --- | --- | --- | --- | --- |
| ChatGPT App / MCP adapter | `feat/chatgpt-preview` | #63 (draft) | Failing | TypeScript type error in `src/tools/runMcpSmoke.ts` — must be resolved before graduating |

The ChatGPT preview adapter is **not part of the operational baseline** and is not exercised by the main commissioning workflow. It must not be merged until all CI checks pass.
