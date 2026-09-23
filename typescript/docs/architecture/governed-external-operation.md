# Governed external operation boundary

Status: adapter over the existing ToolAction executor
Date: 2026-09-23

## What was already authoritative

`ToolExecutionService.execute` is the effect boundary. A single-use action must
win `claimSingleUseExecution` (Convex OCC, including the ΩΣ execution gate).
A reusable action must pass `verifyExecutionEligibility`. External definitions
require an `ExternalReconciliationStore`. Success and indeterminate external
outcomes persist the receipt through that store. A preview PolicyEngine is not
part of this path.

## What was still soft

1. Omega claim refusals were typed out of `SingleUseExecutionClaimResult` and
   mapped to `approval-consumed` even though the claim mutation does not set
   `singleUseClaimId` in those cases.
2. A missing claim block reason used the same consumption code.
3. `new ToolExecutionService(...)` still defaults to an in-memory claim store
   that does not re-read approval state and an in-memory eligibility store that
   returns `eligible: true`. A caller that never reaches Convex can therefore
   treat a fabricated approved action, or a PolicyEngine allowlist, as authority.
4. There was no single adapter a later Temporal activity was required to call.
   The preview activity can still import `GitHubDevelopmentClient` directly.
   This adapter does not remove that function. It is the supported entry.

## What this adapter admits

`GovernedExternalOperation` (`src/actions/governedExternalOperation.ts`):

- `propose` only stages through `ToolActionService`. Approval stays on the
  existing owner path.
- `execute` accepts a project id and action id, reloads the stored action, and
  calls `ToolExecutionService`. The execution idempotency key is derived from
  the action id and live or dry-run mode.
- Construction throws if the service is still on the fail-open in-memory gates.
- `createGovernedExternalOperationFromEnv` returns null unless persistence is
  Convex, then wires the existing Convex action, receipt, and reconciliation
  stores. It does not register a new external effect.
- An indeterminate receipt is returned only when `getByScope` still shows the
  reconciliation the executor scheduled.
- `authorityDecision` may be omitted or
  `omega-tool-action-claim-receipt:v1`. Any other value, including a
  PolicyEngine allowlist, throws `PolicyEngineNotAuthorityError` before a claim
  or an effect.

## What remains refused

- No Temporal workflow, worker, or real GitHub merge activity is added here.
- `verifyExecutionEligibility` still does not repeat the ΩΣ gate. Omega action
  contracts are single-use, so that gate stays inside `claimSingleUseExecution`.
- Unclassified consumption policies are refused by this adapter before
  execution and therefore have no receipt. The HTTP executor still accepts
  legacy rows through its own path.
- Direct `ToolExecutionDefinition.execute` and the in-memory
  `ToolExecutionService` remain available to existing unit tests. They are not
  the Temporal entry.
- No live Convex deployment was exercised.

## How preview Temporal (#572) calls this

The admitted operation is `quotes:send`. `github:merge-pull-request` stays
mocked. Live Graph commissioning is unproven; the activity tests stop at the
`QuoteEmailProvider` seam.

The preview activity `executeGovernedQuoteSend` does the following:

1. `createGovernedExternalOperationFromEnv()` and stop if it returns null.
2. `propose(...)` to stage the ToolAction. Do not approve inside the activity.
3. After the existing owner approval, `execute({ projectId, actionId, authority })`.
4. Do not pass a PolicyEngine decision. Do not call the provider client from
   the activity. The registered tool definition performs the provider call only
   after the claim or eligibility gate inside `ToolExecutionService`.
5. Treat `indeterminate` as reconciliation already scheduled. Do not retry the
   provider from the activity.
