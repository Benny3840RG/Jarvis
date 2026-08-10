# ΩΣ Pass 2 integrity TDD record

Date: 2026-08-10

This record preserves the red-first verification for three runtime-integrity gaps discovered while reconciling superseded PR #363 into PR #364:

1. acceptance-criterion evidence must accumulate across later passing proofs rather than becoming order-dependent;
2. a terminal execution receipt must match the bound action's project, tool, operation and authoritative single-use execution claim before ΩΣ may accept it as mission evidence;
3. an indeterminate external-reconciliation receipt must remain unresolved in ΩΣ until the authoritative reconciliation worker later resolves it, and that later terminal receipt must advance ΩΣ through the post-commit reconciliation boundary.

The corresponding regressions live in `typescript/convex/omegaRuntimeIntegritySecurity.test.ts`. This commit intentionally precedes the production repair so the failing workflow can be retained as negative evidence. Exact red and green workflow IDs are appended after execution.
