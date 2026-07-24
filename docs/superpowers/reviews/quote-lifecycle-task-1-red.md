# Task 1 RED expectation

The current branch intentionally contains Task 1 tests without the production modules they import.

Expected GitHub Actions failure:

- TypeScript cannot resolve `src/quotes/quoteLifecycle.js`.
- TypeScript cannot resolve `src/quotes/quoteFingerprints.js`.

A failing pull-request run proves the tests precede the implementation. The next commit may add only the Task 1 domain modules and repository interfaces required to make these tests pass.
