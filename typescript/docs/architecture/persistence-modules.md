# Persistence module boundaries

Jarvis exposes persistence through `src/persistence/persistence.ts`. That file is a public facade;
runtime behaviour belongs in the focused modules below.

| Module                 | Responsibility                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| `types.ts`             | Shared records, provider contracts, snapshots, and restore results    |
| `assistantState.ts`    | Shared root-object validation before provider state writes            |
| `document.ts`          | JSON document versions, validation, migration, and defensive cloning  |
| `jsonPersistence.ts`   | JSON CRUD plus atomic snapshot and empty-target restore               |
| `jsonFileLock.ts`      | Cross-process JSON writer ownership, timeout, and stale-lock recovery |
| `convexPersistence.ts` | Generated Convex API mapping, CRUD, snapshot, and restore             |
| `providerSelection.ts` | Explicit `json` or `convex` environment selection                     |
| `updates.ts`           | Provider-neutral task and reminder update validation                  |

## Dependency rules

- `document.ts` performs no file or network I/O.
- JSON file locking has one implementation and is used by CRUD, snapshots, and restores.
- Provider selection contains no persistence behaviour and never silently falls back.
- Callers import the facade instead of provider internals.
- JSON and Convex must continue to satisfy the same `PersistenceProvider` contract.

## Behavioural invariants

- Existing version 1 and unversioned JSON documents remain readable.
- Both provider classes reject null, arrays, and primitive assistant-state
  inputs before any write or remote mutation. Empty objects and extensible
  nested state remain supported, for example `saveState({ lastIntent: "help" })`.
  This guard validates the root shape; it does not validate nested application
  fields or replace validation on direct Convex server calls.
- Current writes use version 2 and preserve normalized reminder timezone data.
- Numeric task/reminder creation timestamps must be finite in every document
  version. Missing legacy timestamps still default to zero. Overflowing JSON
  numbers (such as `1e400`) trigger the existing corrupt-file quarantine, which
  preserves the original bytes for recovery.
- JSON mutations reread the latest document after acquiring the cross-process lock.
- Task completion remains idempotent: repeats return the completed task. The
  JSON provider checks completion after its locked reread and returns a copy
  without replacing the state file or migrating a legacy document on a repeat.
- Convex calls use generated API references and service-token authentication.
- Snapshot and restore operations remain provider-atomic.
- Restore continues to refuse a non-empty target and remaps nested record IDs.
