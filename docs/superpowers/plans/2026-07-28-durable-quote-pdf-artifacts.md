# Durable quote PDF artefacts implementation plan

Date: 2026-07-28
Design: `docs/superpowers/specs/2026-07-28-durable-quote-pdf-artifacts-design.md`

## Task 1 — Lock the persistence contract with failing tests

Files:

- Modify `typescript/convex/quotes.test.ts`
- Add `typescript/convex/quotePdfArtifacts.test.ts`
- Modify or add repository-adapter tests as required

Add tests proving that finalisation requires explicit issuer/client presentation data, creates a PDF Blob and immutable artefact row, exposes owner-scoped metadata, rejects stale/duplicate/cross-owner attempts and cleans up storage. Remove tests that call an artefact-free finalisation mutation. Run the focused suite and commit RED evidence.

## Task 2 — Add artefact validators and schema

Files:

- Modify `typescript/convex/schema.ts`
- Add `typescript/convex/quotePdfArtifactValidators.ts`

Define the presentation snapshot and artefact validators. Add `quotePdfArtifacts` with owner-scoped indexes. Keep documents small; store PDF bytes only in Convex storage.

## Task 3 — Split finalisation into prepare and atomic commit

Files:

- Modify `typescript/convex/quotes.ts`
- Add `typescript/convex/quotePdfArtifacts.ts`

Replace the public artefact-free finalisation mutation with internal prepare/commit functions. The prepare query authenticates and validates the authoritative reviewed snapshot. The commit mutation rechecks versions and lifecycle state, verifies `_storage` metadata, atomically persists the finalised snapshot and artefact metadata, and rejects duplicates.

Add an owner-scoped artefact query returning metadata and a signed URL. Extend development cleanup to delete the stored Blob and metadata.

## Task 4 — Add the Node finalisation action

Files:

- Add `typescript/convex/quoteFinalization.ts`
- Reuse `typescript/src/quotes/quotePdfRenderer.ts`

Use `"use node"`. Call prepare, render the exact finalised snapshot, store the Blob, call the atomic commit, and delete the Blob best-effort when commit fails. Do not access Outlook or environment-backed customer identity.

## Task 5 — Update the TypeScript repository boundary

Files:

- Modify `typescript/src/persistence/convexPersistence.ts`
- Modify `typescript/src/quotes/quoteRepository.ts`
- Modify `typescript/src/quotes/convexQuoteRepository.ts`
- Modify callers and tests

Extend the injectable client boundary with `action`. Change finalisation input to require issuer/client presentation snapshots. Stamp the time inside the server action, route the repository adapter through it and map domain errors without exposing content.

## Task 6 — Documentation and full verification

Files:

- Modify `docs/deployment.md`
- Modify OpenAPI only if an existing public quote-finalisation endpoint is present

Run dependency audit, type-check, Convex lint rules, Prettier, OpenAPI validation, focused tests, the full Node/Convex coverage suite and Console build. Inspect the complete PR diff, all workflows and review threads. Repair confirmed defects, then merge the exact verified head. Do not deploy or activate Outlook.
