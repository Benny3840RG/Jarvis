# Provider mutation contract

## Purpose

JSON and Convex store the same task and reminder records. Rules about who may
change those records must not depend on which backend is active. The provider
mutation contract is one table of cases that both backends run through their
real provider classes.

- Cases: `tests/contracts/providerMutationContract.ts`
- JSON runner (node:test): `tests/providerMutationContract.json.test.ts`
- Convex runner (vitest + convex-test): `convex/providerMutationContract.test.ts`
- Shared rule under test: `src/persistence/directMutationPolicy.ts`

## Capabilities

Backends do not expose identical APIs, so each case declares what it needs:

| Capability    | Meaning                                        | JSON | Convex |
| ------------- | ---------------------------------------------- | ---- | ------ |
| `direct`      | `PersistenceProvider` CRUD and restore         | yes  | yes    |
| `controlled`  | `ControlledTaskStore` (project-scoped changes) | no   | yes    |
| `serviceAuth` | service-token authentication                   | no   | yes    |

A harness that lacks a capability reports those cases as **skipped with a
reason**, not passed, so the JSON gaps stay visible in test output.

## What is covered

- Restore keeps `projectId` on tasks and reminders.
- Personal records: update, complete, re-complete (no-op) and remove work.
- Unknown IDs return `null` for every direct mutation.
- Project-scoped records reject direct update/complete/remove and stay unchanged.
- Controlled complete: succeeds on its own project, bumps revision, replays
  idempotently, refuses another project and refuses personal tasks; direct
  mutation stays rejected afterwards.
- A rejected service token can neither read nor mutate, and changes nothing.

## Adding a case

Add an entry to `providerMutationContract` with the narrowest `requires`
capability. Use the module's `check`/`rejects` helpers (plain `Error`), not a
runner's assertion library, so both runners can execute it. Before relying on a
new case, break the rule it protects locally and confirm the case fails on
every backend that declares the capability.
