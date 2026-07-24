# Task 1 review brief — quote lifecycle domain contracts

## Scope

Implement only Task 1 from `docs/superpowers/plans/2026-07-24-quote-lifecycle.md`:

- `typescript/src/quotes/quoteLifecycle.ts`
- `typescript/src/quotes/quoteFingerprints.ts`
- `typescript/src/quotes/quoteRepository.ts`
- `typescript/src/quotes/quoteDeliveryRepository.ts`
- `typescript/tests/quoteLifecycleDomain.test.ts`
- `typescript/tests/quoteFingerprints.test.ts`

## Required interfaces

- `QuoteAggregate`, `QuoteRevision`, `QuoteDeliveryAttempt`, `QuoteSnapshot`
- `computeQuoteTotals`, `applyDraftPatch`, `assertRevisionTransition`
- `normalizeQuoteRecipient`, `quoteRevisionFingerprint`, `quoteSendFingerprint`
- repository interfaces for later tasks

## Binding constraints

- Development only; no deployment.
- AM-012, AM-013 and WF-QUOTE-001 remain planned.
- No Outlook send or calendar action.
- Totals are server-derived.
- Finalised revisions are immutable.
- Only transitions `draft:reviewed`, `reviewed:draft`, `reviewed:finalized` are valid.
- Hash prefixes are exactly `quote-revision:v1:sha256:` and `quote-send:v1:sha256:`.
- Keep scope limited to domain contracts; no Convex, HTTP or provider implementation.
