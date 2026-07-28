# Outlook quote draft provider implementation plan

**Date:** 2026-07-28  
**Branch:** `feat/outlook-quote-draft-provider`

1. Add failing provider-contract tests for prepare/register/send ordering and indeterminate acceptance.
2. Split the quote email provider interface into prepare and send-prepared phases.
3. Update the quote send tool to persist the provider reference before sending and to mark Graph acceptance indeterminate.
4. Add failing Microsoft Graph provider tests covering message construction, immutable IDs, validation, redaction, and response classification.
5. Implement the injected, unactivated Microsoft Graph provider.
6. Keep environment/runtime composition disabled.
7. Update affected fixtures, smoke tests, and documentation.
8. Run audit, type-check, lint, formatting, OpenAPI, full coverage, Console build, and policy checks.
9. Open a draft PR early, review the exact diff, repair confirmed defects, and merge only after fresh exact-head verification.
