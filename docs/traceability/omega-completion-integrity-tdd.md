# ΩΣ Completion Integrity — TDD and Verification Evidence

**Issue:** [#378](https://github.com/Benny3840RG/Jarvis/issues/378)
**Pull request:** [#383](https://github.com/Benny3840RG/Jarvis/pull/383)
**Scope:** OS-CI-001–OS-CI-012
**Verification mode:** repository-only; no deployment or commissioning

## Authority model proved

`acceptanceCriteria[].status` and `acceptanceCriteria[].evidenceRefs` remain a
backward-compatible compatibility projection. They are not completion authority
and are deliberately excluded from the completion-policy input.

Completion now derives its decision from:

1. immutable criterion IDs and statements;
2. current passing validation proofs, each backed by current same-owner,
   same-mission evidence;
3. current certain-evidence contradiction edges after applying exact-edge,
   append-only contradiction resolutions;
4. existing external-effect reconciliation state; and
5. residual uncertainty against the mission uncertainty budget.

No existing mission, evidence, or proof rows were rewritten or deleted. The
legacy projection remains readable and may continue to be maintained for
compatibility, but disagreement between that projection and authoritative
proof/evidence state no longer authorises completion.

## RED evidence

The intentional RED commit was:

`87cd56ed342ddd17a00c2cc942b3a6313f4992ff` —
`test(omega): require proof-authoritative completion policy`

Command run at that exact commit:

```bash
cd typescript
node --import tsx --test tests/omegaPolicy.test.ts
```

Result: **13 tests, 10 passed, 3 failed**.

The failing tests were:

- `requires a passing proof for every criterion` — the expected
  `criterion-missing-passing-proof:AC-1` failure was absent;
- `R3 and R4 require independent validation` — the expected
  `criterion-missing-independent-proof:AC-1` failure was absent; and
- `allows completion from criterion definitions plus current proof evidence` —
  completion was denied with `acceptance-criteria-incomplete` even though the
  definition-only criterion had a passing proof with evidence.

This RED result demonstrated the old projected-status authority path: the new
definition-only fixtures were being filtered by the production policy's
`criterion.status` checks, so persisted projected state still controlled
completion semantics.

## GREEN evidence

The implementation and tests were verified at:

`23818db872b67f93feecf42d9abce6ae946c5f83` —
`style(omega): format contradiction resolution mutation`

Focused tests:

```bash
cd typescript
node --import tsx --test tests/omegaPolicy.test.ts
./node_modules/.bin/vitest run --config vitest.config.mts convex/omega*.test.ts
```

Results:

- policy: **13 passed, 0 failed**;
- ΩΣ Convex suite: **10 files, 37 tests passed, 0 failed**.

Repository gate:

```bash
cd typescript
npm run check
```

Result: **exit 0**.

- Node: **959 passed, 0 failed**;
- Convex: **29 files, 183 tests passed, 0 failed**;
- TypeScript type-check, ESLint, Prettier, and OpenAPI lint passed.

## Exact-head GitHub Actions evidence

The exact implementation head above produced these successful GitHub Actions
runs:

| Workflow             |                                                                           Run | Successful jobs                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript checks    | [32365284970](https://github.com/Benny3840RG/Jarvis/actions/runs/32365284970) | `automation-policy` job `96413351469`; `typecheck-lint-format-test` job `96413351600`; `jarvis-console-01-build` job `96413351705` |
| Copilot Review Check | [32365285052](https://github.com/Benny3840RG/Jarvis/actions/runs/32365285052) | `copilot-review-section` job `96413351365`                                                                                         |

No separate CodeQL or governance-validation run was emitted for this PR head;
neither is claimed as evidence here. The PR's available exact-head CI is the
TypeScript and Copilot evidence listed above.

## Scope and safety boundary

PR #383 contains the ΩΣ implementation, tests, requirements, architecture and
traceability changes only. This evidence increment adds documentation and
registry links only. It introduces no unrelated runtime, dependency,
deployment, Outlook/Graph, HTTP, MCP, remote-exposure, or production-
authorisation change.

No Convex deployment, Outlook/Graph send, customer effect, or commissioning
was performed.
