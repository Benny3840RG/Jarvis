# Persistence module boundaries

Jarvis exposes persistence through `src/persistence/persistence.ts`. That file is a public facade;
runtime behaviour belongs in the focused modules below.

| Module                 | Responsibility                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| `types.ts`             | Shared records, provider contracts, snapshots, and restore results    |
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
- Current writes use version 2 and preserve normalized reminder timezone data.
- JSON mutations reread the latest document after acquiring the cross-process lock.
- Convex calls use generated API references and service-token authentication.
- Snapshot and restore operations remain provider-atomic.
- Restore continues to refuse a non-empty target and remaps nested record IDs.
