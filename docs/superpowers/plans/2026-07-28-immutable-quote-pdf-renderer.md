# Immutable Quote PDF Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce deterministic, client-ready A4 PDF bytes from one authoritative finalized quote revision.

**Architecture:** A pure Node renderer validates the immutable quote snapshot and explicit presentation details, lays content into bounded pages, serializes a narrow PDF 1.7 object graph, and returns bytes plus a SHA-256 artefact digest. The module performs no I/O and adds no dependency.

**Tech Stack:** TypeScript 6, Node.js 24 built-in crypto and Buffer, Node test runner, Poppler for visual verification.

## Global Constraints

- No new package dependency.
- No filesystem, network, environment, Convex, Outlook, or clock access from the renderer.
- Accept only finalized revisions with a valid `quote-revision:v1:sha256:<64 hex>` fingerprint.
- PDF page size is A4: 595.28 x 841.89 points.
- Text is limited to printable Windows-1252 characters and encoded as PDF hexadecimal strings.
- Maximum 200 line items, 160 characters per item description, 2,000 characters of notes, and 8 address lines per party.
- Maximum output is 2 MiB.
- Every behaviour change follows a verified red-green test cycle.
- No live Outlook request, credential setup, Convex deployment, Manufact deployment, or production deployment.

---

### Task 1: Renderer contract and validation

**Files:**
- Create: `typescript/tests/quotePdfRenderer.test.ts`
- Create: `typescript/src/quotes/quotePdfRenderer.ts`

**Interfaces:**
- Consumes: `QuoteSnapshot` from `quoteLifecycle.ts`.
- Produces:
  - `QuotePdfParty`
  - `QuotePdfRenderInput`
  - `QuotePdfArtifact`
  - `QuotePdfError`
  - `renderFinalizedQuotePdf(input)`

- [ ] **Step 1: Write the failing finalized-render test**

Create a finalized `QuoteSnapshot` with two line items, 10% GST, explicit issuer/client details, and a fixed `generatedAt`. Assert:

```ts
const artifact = renderFinalizedQuotePdf(input);
assert.equal(artifact.mediaType, "application/pdf");
assert.equal(artifact.filename, "Quote-Q-2026-001-R1.pdf");
assert.match(artifact.digest, /^quote-pdf:v1:sha256:[a-f0-9]{64}$/);
assert.equal(artifact.byteLength, artifact.bytes.byteLength);
assert.equal(Buffer.from(artifact.bytes.subarray(0, 8)).toString("ascii"), "%PDF-1.7");
```

The production break caught is absence of the renderer contract.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd typescript
node --import tsx --test tests/quotePdfRenderer.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `quotePdfRenderer.js`.

- [ ] **Step 3: Implement validation and one-page serialization**

Implement stable error codes:

```text
quote-pdf-not-finalized
quote-pdf-fingerprint-invalid
quote-pdf-identity-mismatch
quote-pdf-totals-invalid
quote-pdf-party-invalid
quote-pdf-content-invalid
quote-pdf-limit-exceeded
quote-pdf-output-too-large
```

Create a narrow PDF object builder with catalog, pages, page, content stream, Helvetica and Helvetica-Bold font objects, xref, trailer and deterministic document ID derived from the revision fingerprint. Encode all text as Windows-1252 hexadecimal strings.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused test. Expected: PASS.

Commit:

```text
feat(quotes): render finalized quote PDF
```

---

### Task 2: Determinism, injection safety, and pagination

**Files:**
- Modify: `typescript/tests/quotePdfRenderer.test.ts`
- Modify: `typescript/src/quotes/quotePdfRenderer.ts`

- [ ] **Step 1: Add failing tests**

Add separate tests proving:

- identical input returns byte-identical output and digest;
- a changed generation timestamp or line item changes the digest;
- quote numbers containing path separators produce a safe filename;
- parentheses, backslashes, percent signs and fake PDF operators remain encoded as data;
- non-finalized, missing fingerprint, identity mismatch, non-finite totals and total inconsistency fail with their stable code;
- client content is absent from error messages;
- 60 line items create multiple pages and repeat the table heading;
- every page contains the revision fingerprint and `Page N of M`.

- [ ] **Step 2: Verify RED**

Expected failures: missing pagination, unsafe filename or missing validation.

- [ ] **Step 3: Implement minimal layout expansion**

Add:

- deterministic word wrapping by measured Helvetica width;
- footer reservation;
- page breaking before rows or notes cross the footer;
- repeated header/table heading;
- final page-count substitution before serialization;
- safe filename tokenisation to ASCII alphanumerics and hyphens.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused test and then:

```bash
npm run type-check
npm run lint
npm run format:check
```

Commit:

```text
feat(quotes): paginate immutable quote PDFs
```

---

### Task 3: Visual and permanent verification

**Files:**
- Create: `typescript/src/tools/renderQuotePdfFixture.ts`
- Modify: `docs/deployment.md`

- [ ] **Step 1: Add a development-only fixture command**

The command builds a fixed multi-page sample and writes only to a caller-supplied path. It must not read environment variables or production data.

- [ ] **Step 2: Render and inspect**

Run:

```bash
cd typescript
node --import tsx src/tools/renderQuotePdfFixture.ts /tmp/jarvis-quote-fixture.pdf
pdfinfo /tmp/jarvis-quote-fixture.pdf
pdftoppm -png /tmp/jarvis-quote-fixture.pdf /tmp/jarvis-quote-fixture
```

Inspect every PNG for clipping, overlaps, missing glyphs, broken totals, and footer collisions.

- [ ] **Step 3: Document the boundary**

Record that the renderer is implemented but not yet persisted or connected to finalisation/send. State that no quote is sendable until the later durable artefact and Outlook slices are both complete.

- [ ] **Step 4: Run the permanent gate**

Run:

```bash
cd typescript
npm ci
npm audit
npm run type-check
npm run lint
npm run format:check
npm run openapi:lint
npm run test:coverage
```

Require Console build, automation-policy and Copilot Review Check on the exact PR head.

- [ ] **Step 5: Review and integrate**

Review the diff for hidden I/O, unsafe interpolation, non-determinism and authority expansion. Open a draft PR with exact RED/GREEN evidence, repair deterministic findings test-first, and merge only after exact-head gates are green and review threads are clear.
