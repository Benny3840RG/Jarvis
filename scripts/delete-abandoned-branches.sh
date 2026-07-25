#!/usr/bin/env bash
# Deletes the 67 branches identified as abandoned in the Jarvis repo audit
# (all had a merged PR whose commits are on main, a PR that was closed
# without merging and superseded, or no PR at all with content long since
# superseded on main). Excludes claude/jarvis-optimal-build-dfp5je, the
# active designated development branch.
#
# Run from a clone with push access to Benny3840/Jarvis, e.g.:
#   git clone https://github.com/Benny3840/Jarvis.git && cd Jarvis
#   bash delete-abandoned-branches.sh
#
# Safe to re-run: deleting an already-deleted branch just prints a harmless
# "remote ref does not exist" error and the script continues.

set -u
cd "$(dirname "$0")" 2>/dev/null || true

BRANCHES=(
  agent/atomic-backups
  agent/automate-dependency-updates
  agent/backup-restore
  agent/convex-openai-totality-persistence
  agent/convex-smoke-test
  agent/dev-commissioning
  agent/dev-sync-smoke
  agent/durable-persistence
  agent/eslint-format-checks
  agent/failure-matrix
  agent/fix-json-locks
  agent/fix-reminder-normalization
  agent/fix-runtime-cache
  agent/ignore-backup-data
  agent/ignore-backups
  agent/json-write-locking
  agent/memory-approval-apply
  agent/p1-ownership-concurrency
  agent/p2-coverage-failure-paths
  agent/p2-document-scaffold-boundaries
  agent/p3-cli-deployment-hardening
  agent/reasoning-memory-proposals
  agent/recover-clean-baseline
  agent/refresh-durable-lists
  agent/reminder-due-normalization
  agent/service-token-rotation
  agent/simplify-ci-checks
  agent/split-persistence-modules
  agent/task-reminder-updates
  agent/task-removal
  agent/tool-action-approval
  agent/totality-contracts-validation
  agent/totality-http-api
  agent/totality-policy-foundation
  agent/totality-reasoning-http-pipeline
  agent/typed-convex-client
  agent/typed-convex-contract
  agent/typed-orchestration-core
  chore/governance-file-layout
  chore/one-shot-development-commissioning
  ci/commissioning-status-reporting
  ci/current-commissioning-status
  ci/diagnose-totality-http
  ci/fix-install-package
  ci/operator-boundary-diagnostics
  claude/fix-inflight-fingerprint-race
  claude/jarvis-governance-index
  copilot/fix-align-commissioning-authority
  copilot/fix-copilot-issue
  copilot/what-is-remaining-to-be-done-with-jarvis
  dependabot/npm_and_yarn/typescript/development-dependencies-024a93f705
  docs/dry-run-receipt-persistence
  feat/convex-persistence
  feat/convex-quote-repository
  feat/external-reconciliation-154
  feat/http-system-boundary
  fix/brace-expansion-audit-regression
  fix/classify-openai-quota
  fix/commissioning-totality-t1
  fix/convex-ci-disable-log-tail
  fix/convex-dev-sync-diagnostics
  fix/main-vitest-audit-regression
  fix/quote-adapter-contract-152
  fix/quote-http-contract-152
  fix/restore-orchestrator-boundary
  perf/bound-owner-list-reads
  security/audit-payload-credential-filter
)

echo "Deleting ${#BRANCHES[@]} branches from origin..."
fail=0
for b in "${BRANCHES[@]}"; do
  if git push origin --delete "$b"; then
    echo "OK   $b"
  else
    echo "FAIL $b"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "All branches deleted successfully."
else
  echo "Some deletions failed — see FAIL lines above."
fi
