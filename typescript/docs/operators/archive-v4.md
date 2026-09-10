# Archive v4 — core and memory groups (stage 2)

Archive v4 is a **separate, additive** backup format. It does not replace
`npm run backup -- export|verify|restore`; those commands, and every v1/v2/v3
archive already on disk, keep working exactly as before.

This stage covers two of the six required groups, read directly from JSON
storage:

| Group    | Contents                                          | Source files                                                                                                                                     |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core`   | assistant state, tasks, reminders                 | `data/jarvis-state.json`                                                                                                                         |
| `memory` | builds, build logs, upgrades, assets, preferences | `data/jarvis-builds.json`, `data/jarvis-build-logs.json`, `data/jarvis-upgrades.json`, `data/jarvis-assets.json`, `data/jarvis-preferences.json` |

`businessRecords`, `notesAndEvidence`, `orchestration` and `quoteAggregate` are
**not covered yet**, so **every archive this stage writes is
`completeness: partial`** and is refused by the full-recovery restore path. That
is the honest state, not an exclusion: the manifest lists the four groups as
absent and claims no recovery method for them.

## Commands

```
npm run backup -- export-v4 <file>
npm run backup -- verify-v4 <file>
npm run backup -- restore-v4 <file> <empty-destination-dir> [--allow-partial]
```

- **`export-v4`** captures both groups under one coordinated set of file locks,
  held for the whole read, so no writer can change one file after another has
  been captured. It refuses to write over an existing file, and writes `0600`.
- **`verify-v4`** materialises the archive into a throwaway directory and runs
  the same two-way verification a real restore runs, then removes it. It never
  reads or writes live storage.
- **`restore-v4`** materialises the archive into a directory it creates itself.

`PERSISTENCE_PROVIDER` must select `json`. Under `convex` the export refuses
rather than writing an archive that omits the data actually in use.

## What "strict and lossless" means here

The runtime stores are deliberately forgiving: they quarantine a malformed file,
skip an invalid row and default a missing timestamp. A backup that did the same
would silently produce a smaller, different dataset than the source. The v4
readers therefore **abort the whole capture** on:

- malformed JSON (and, unlike the stores, they leave the file where it is),
- an unsupported document version, an unknown field, or a missing array,
- an invalid record, a duplicate id within a collection,
- a symlinked source file.

Only a file that has genuinely never been created is reported as empty. Ids,
timestamps and array order are preserved verbatim — nothing is renumbered,
re-sorted or re-stamped.

## Derived values must agree with their inputs

Quote and invoice totals are recomputed from line items on every read, and an
invoice's `status` is partly derived from its payments. A stored value that no
longer matches its inputs is therefore not recoverable data — the runtime
silently replaces it on load, so an archive that carried it could never round
trip.

Each business domain is read twice for this reason: once by the strict reader
and once through its own ordinary store. The two must agree exactly. Any value
the runtime would change on load — a drifted quote total, an
un-deduplicated hazard list, a row the store would skip because its id is not a
string — fails the capture by name rather than producing an archive that cannot
be restored faithfully.

## References the source itself cannot resolve

No business domain guards or cascades a deletion: removing a client leaves its
properties, projects, quotes, invoices and enquiries in place, and nothing
validates the id when they are created. Deleting a build likewise does not
cascade to its logs and upgrades, and nothing enforces that dependency either.
A record whose referent is gone is a **legal state of live data**, not
corruption. Refusing to capture it would make the backup unusable after an
ordinary deletion, and would lose rows that are still authoritative.

Such rows are therefore captured verbatim and the broken edge is recorded in the
manifest's `unresolvedReferences`, printed by every command:

```
2 reference(s) in the source do not resolve. They are captured as-is, not repaired:
  buildLogs/log-1.buildId -> builds/build-deleted (missing)
  projects/project-1.clientId -> clients/client-deleted (missing)
```

The edges checked are `properties.clientId`, `projects.clientId`,
`projects.propertyId`, `quotes.clientId`, `quotes.projectId`,
`invoices.clientId`, `invoices.projectId`, `invoices.quoteId`,
`enquiries.clientId`, `enquiries.propertyId`, `enquiries.convertedProjectId`,
`errands.projectId`, `buildLogs.buildId` and `upgrades.buildId`.

This does not change `completeness`, which describes group coverage rather than
the source's own consistency. What the archive does guarantee is that it never
_introduces_ a broken edge: the list is re-derived from the data read back off
disk during restore verification and compared against the manifest's, so an
archive cannot understate a broken edge it carries or claim one it does not.

## Restore semantics

`restore-v4` never merges and never overwrites:

- The destination must not exist. It is reserved with an exclusive `mkdir`; an
  existing directory — including a leftover from a failed restore — is refused
  and must be removed by an operator.
- A destination that overlaps the live Jarvis data directory is refused.
- A symlinked destination is refused.

After writing, both readers must agree: every document is re-read strictly _and_
through a fresh ordinary runtime store, and any difference fails the restore
rather than reporting success. Only then is `.jarvis-archive-v4-complete.json`
written. **The absence of that marker is the signal that a restore was
interrupted**; the directory left behind is unmistakably incomplete and a retry
refuses it.

The restored directory also carries a copy of the archive's `manifest.json`, so
it is self-describing and a partial restore cannot later be mistaken for a
recovery image.

### Business settings

Business settings are a single object rather than a collection, and "the file has
never been written" is a real state distinct from "written with default values" —
the store synthesises defaults on read either way. A source with no settings file
is captured as `businessSettings: null` (manifest count `0`), and restore writes
no settings file, so the restored deployment reads exactly the same defaults.

### `--allow-partial`

Because this stage always produces a partial archive, `restore-v4` needs
`--allow-partial` to materialise one. That flag is an acknowledgement that the
result is a **staged development restore, not a recovery**. Without it the
full-recovery path refuses, naming the absent groups.
