# Immutable Quote PDF Renderer Design

**Date:** 2026-07-28  
**Status:** Approved for repository implementation  
**Scope:** Deterministic PDF artefact generation only; no persistence, Outlook access, sending, or deployment

## Objective

Create the client-ready PDF bytes that later finalisation and Outlook slices can lock and send. The renderer must turn one authoritative finalized quote revision plus explicit issuer and client presentation details into a deterministic A4 PDF artefact.

## Verified baseline

- Quote revisions already become immutable when finalized and carry a SHA-256 revision fingerprint.
- The quote send tool already rejects non-finalized, stale, or fingerprint-mismatched revisions.
- The repository has no PDF dependency or renderer.
- Quote records retain a client ID but do not contain enough presentation data to invent a client's name or address.
- Outlook reconciliation exists as an uncomposed read-only adapter; no send-capable provider is configured.

## Approaches considered

1. **Small deterministic renderer using the PDF 1.7 format and standard Helvetica fonts - selected.**
   - No dependency or lockfile expansion.
   - Complete control of document metadata, object ordering, timestamps, escaping, pagination, and byte stability.
   - Limited to the Windows-1252 character set in this slice; unsupported characters fail closed.

2. Add a general PDF library.
   - Faster access to richer layout features.
   - Adds a production dependency and a broad API surface before the required document contract is known.

3. Render HTML in a headless browser.
   - Strong visual flexibility.
   - Adds a large runtime, platform variability, and unnecessary attack surface for a quote document.

## Architecture

`renderFinalizedQuotePdf(input)` is a pure Node function. It accepts:

- the authoritative `QuoteSnapshot`;
- explicit issuer presentation details;
- explicit client presentation details;
- the generation timestamp that will later be stored with the artefact.

It returns:

- exact PDF bytes;
- `application/pdf`;
- a safe filename derived from the quote number and revision;
- byte length;
- a `quote-pdf:v1:sha256:<hex>` digest.

The renderer performs no file, network, environment, Convex, Outlook, or clock I/O. Callers supply all variable data.

## Document contract

The A4 document contains:

- issuer name and optional ABN/contact/address;
- quote number, revision, finalized date, valid-until date, and client details;
- line item descriptions, quantities, unit prices, and totals in AUD;
- notes and standard terms marker when present;
- page number and immutable revision fingerprint on every page;
- deterministic PDF metadata.

Long descriptions and notes wrap safely. Content paginates before the footer zone. Repeated table headings appear after a page break.

## Validation and failure behaviour

The renderer rejects:

- a non-finalized revision;
- missing or malformed revision fingerprints;
- aggregate/revision identity mismatch;
- non-finite or inconsistent monetary totals;
- empty issuer or client names;
- control characters;
- unsupported characters that cannot be represented safely;
- overlong presentation fields or excessive line-item counts.

Errors expose stable `QuotePdfError` codes and do not include client content.

## Security and authority boundary

- No active content, JavaScript, attachments, external links, forms, or encryption.
- User strings are encoded as PDF hexadecimal strings, not interpolated into PDF syntax.
- No Outlook permissions, tokens, Graph requests, email draft, send operation, persistence write, Convex deployment, or production deployment.
- A later slice will persist the returned bytes and digest before a quote is considered finalized.
- A still later slice will attach only that stored immutable artefact to an Outlook draft.

## Test contract

Tests prove:

- deterministic bytes and digest for identical inputs;
- changed inputs produce a changed digest;
- the PDF header, xref, trailer, page count, media type, and safe filename;
- finalized/fingerprint/totals/identity gates;
- content encoding prevents PDF syntax injection;
- wrapping and multi-page output;
- stable error codes without client-data leakage.

A generated fixture must also be rendered to PNG with Poppler and visually inspected before the slice is declared complete.
