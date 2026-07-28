# Durable quote PDF artefacts

Date: 2026-07-28
Status: Approved

## Objective

Make `finalized` a durable business invariant: a quote revision may enter the finalised state only when the exact client-ready PDF for that revision is stored, fingerprint-bound and recorded in the same Convex commit.

## Scope

This slice adds finalisation-time PDF storage and retrieval metadata. It does not configure Microsoft OAuth, create Outlook drafts, send email, call a live provider or deploy production.

## Invariants

- Only a reviewed current revision may be finalised.
- The existing owner, quote/revision identity and optimistic-version checks remain authoritative.
- The PDF is generated from the authoritative reviewed snapshot plus explicit issuer and client presentation snapshots. IDs are never rendered as customer-facing identity.
- The renderer receives the finalised form of the authoritative revision so the embedded revision fingerprint is exact.
- A successful finalisation mutation changes the revision to `finalized` and inserts exactly one `quotePdfArtifacts` row atomically.
- The artefact row is immutable and uniquely indexed by owner, quote and revision.
- The stored Blob is `application/pdf`; its storage ID, byte length, digest, filename, renderer version, generation time and presentation snapshots are retained.
- There is no public mutation that can finalise without an artefact.
- Replays are fail-closed: a stale or duplicate finalisation cannot replace the locked artefact.
- Retrieval is owner-scoped and returns metadata plus a short-lived signed storage URL; raw storage IDs do not grant authority.
- If Blob storage succeeds but the atomic commit loses a race, the action deletes the unreferenced Blob best-effort before returning the original domain error.
- Development cleanup deletes the referenced Blob and metadata with the quote.

## Architecture

A Node Convex action owns the orchestration because the deterministic PDF renderer uses Node crypto and Convex actions can store Blobs.

1. Validate the service token and explicit issuer/client presentation input.
2. Run an internal query that resolves the owner-scoped authoritative reviewed revision and checks expected versions.
3. Produce the finalised snapshot and its revision fingerprint without persisting it.
4. Render the deterministic PDF from that snapshot.
5. Store the PDF Blob.
6. Run one internal mutation that rechecks identity, state and versions, verifies storage metadata, replaces the quote/revision snapshot and inserts the immutable artefact row atomically.
7. On commit failure, delete the newly stored Blob best-effort and preserve the original error.

The external TypeScript repository adapter calls this action. Its finalisation input gains explicit `issuer`, `client` and `generatedAt` values. No process-global customer identity defaults are permitted.

## Data model

`quotePdfArtifacts` contains:

- ownerId, quoteId, revisionId, revision and revisionFingerprint
- storageId (`v.id("_storage")`)
- digest (`quote-pdf:v1:sha256:...`), byteLength and mediaType
- filename and rendererVersion
- generatedAt and createdAt
- immutable issuer and client presentation snapshots

Indexes:

- `by_owner_quote_and_revision`
- `by_owner_revision_id`

## Failure behaviour

Stable domain or artefact error codes are surfaced without quote content, addresses or access tokens. Unsupported text, invalid presentation data, oversized output, missing storage metadata, stale versions, invalid lifecycle transitions and duplicates all fail before the revision becomes finalised.

A crash after Blob storage but before the commit can leave an unreferenced storage object. The normal error path deletes it; operational orphan sweeping is a later maintenance concern and does not weaken the finalised-state invariant.

## Verification

Tests must prove:

- the old artefact-free public finalisation path is absent;
- successful action finalisation persists exactly one matching artefact;
- revision fingerprint, PDF digest, Blob size and stored metadata agree;
- stale, duplicate, cross-owner and invalid-presentation attempts fail closed;
- a commit race leaves the reviewed revision unchanged and attempts Blob cleanup;
- signed URL retrieval is owner-scoped;
- quote cleanup removes the Blob and metadata;
- existing quote revision, delivery and reconciliation tests remain green.
