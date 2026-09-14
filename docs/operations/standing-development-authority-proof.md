# Standing Development authority proof

Evidence required before merge:

1. `node --test .github/automation/development-workflow.test.mjs` passes.
2. `node --test .github/automation/validate-autobuild.test.mjs` passes.
3. `node --test .github/automation/*.test.mjs` passes.
4. `npm run check --prefix typescript` passes.
5. `npm run build --prefix typescript/jarvis-console-01` passes.
6. Required PR checks pass on the exact candidate head.
7. `jarvis-pr-maintenance/review` passes on the exact candidate head.
8. Diff inspection confirms no autonomous merge or deployment authority was added.
