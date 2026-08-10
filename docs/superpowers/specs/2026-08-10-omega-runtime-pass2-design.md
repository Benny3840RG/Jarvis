# ΩΣ Runtime Pass 2 — Design

## Current truth

Jarvis already has the authoritative external-effect boundary: governed `toolActions`, atomic single-use execution claims, reusable eligibility re-checks, durable `toolExecutionReceipts`, approval expiry/revocation, and audit evidence. ΩΣ must not replace or bypass those controls.

PR #361 strengthens the same control plane by requiring dedicated approval and delivery-runtime credentials inside Convex. This ΩΣ branch is intentionally stacked on that head so Pass 2 inherits the stronger boundary.

## Goal

Add a durable mission/control layer that can bind selected single-use governed tool actions to an ΩΣ mission, block execution when mission authority is invalid, and reconcile terminal Jarvis receipts back into mission evidence without creating a second executor.

## Architecture

### Mission state

`omegaMissions` stores objective, risk/autonomy/reversibility classes, uncertainty budget, acceptance criteria, policy version, and lifecycle state.

### Evidence and validation

`omegaEvidence` stores durable evidence references. `omegaValidationProofs` binds proofs to real acceptance criteria and evidence. Mission completion requires every criterion to be proven; R3/R4 missions require independent proof.

### Action contracts

`omegaActionContracts` is a one-to-one bridge from an ΩΣ mission to an existing Jarvis `toolActions` row. Pass 2 supports only `single-use` tool actions. Reusable ΩΣ actions are deferred until a generation/counter model exists, avoiding accidental conversion of reusable Jarvis semantics into one-shot semantics.

A contract may become `authorized` only when the underlying Jarvis action is approved, authority matches, and ΩΣ expiry does not exceed the Jarvis approval expiry.

### Execution gate

The ΩΣ gate executes inside `claimSingleUseExecution`, after Jarvis's authoritative state/expiry re-check and before the single-use claim is persisted. Non-ΩΣ actions remain unchanged. Contract-bound actions are blocked when the mission is not executable, the contract is not authorized, authority differs, or ΩΣ authority expired.

No parallel tool executor is introduced.

### Receipt reconciliation

`toolExecutionReceipts` remains the durable execution outcome source. On terminal receipt creation or idempotent re-read, ΩΣ reconciliation records mission evidence and moves the bound contract to `reconciled`. Reconciliation is idempotent.

## Data flow

1. Create ΩΣ mission and acceptance criteria.
2. Stage and approve a normal Jarvis single-use tool action through the existing governed path.
3. Bind an ΩΣ action contract to that tool action.
4. Authorize the contract only while the underlying Jarvis approval is valid.
5. Execution calls `claimSingleUseExecution`; Jarvis state/expiry checks run first, then ΩΣ contract/mission checks, then the existing atomic claim is written.
6. Existing runtime attempts the external effect and writes `toolExecutionReceipts`.
7. Receipt reconciliation converts the terminal outcome into ΩΣ evidence and reconciles the contract.
8. Mission completion remains unavailable until all bound contracts are reconciled and all acceptance criteria satisfy validation policy.

## Failure handling

- Missing contract for a normal Jarvis action: execute under existing rules.
- Missing/invalid contract for an ΩΣ-bound action: fail closed before claim/effect.
- Expired/revoked Jarvis approval: existing Jarvis boundary blocks first.
- Expired ΩΣ authority: ΩΣ gate blocks before the single-use claim.
- Duplicate terminal receipt: reconciliation is idempotent.
- Indeterminate receipt: record durable evidence; do not infer success.
- Reusable tool action binding attempt: reject until reusable execution generations are designed.

## Verification

Required before the PR is ready:

- TypeScript type-check, lint, format and OpenAPI/static checks through the repository gate.
- Existing Node and Convex suites remain green.
- New policy tests for acceptance-criterion/evidence binding and independent R3/R4 proof.
- New Convex integration tests for authorization, expiry, blocked mission execution, receipt reconciliation, and completion blocking while contracts remain unresolved.
- GitHub CI green on the exact head.

## Deferred scope

Pass 2 does not expose new HTTP/MCP/OpenAPI mission endpoints, does not commission reusable ΩΣ contracts, and does not add autonomous orchestration. Those require this control-plane foundation to be proven first.
