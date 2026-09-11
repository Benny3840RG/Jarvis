# Archive v4 — core, memory and business record groups

Archive v4 is a **separate, additive** backup format. It does not replace
`npm run backup -- export|verify|restore`; those commands, and every v1/v2/v3
archive already on disk, keep working exactly as before.

Three of the six required groups are covered, read directly from JSON storage:

| Group             | Contents                                                                               | Source files                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`            | assistant state, tasks, reminders                                                      | `data/jarvis-state.json`                                                                                                                                                                                                                       |
| `memory`          | builds, build logs, upgrades, assets, preferences                                      | `data/jarvis-builds.json`, `data/jarvis-build-logs.json`, `data/jarvis-upgrades.json`, `data/jarvis-assets.json`, `data/jarvis-preferences.json`                                                                                               |
| `businessRecords` | clients, properties, projects, quotes, invoices, enquiries, errands, business settings | `data/jarvis-clients.json`, `data/jarvis-properties.json`, `data/jarvis-projects.json`, `data/jarvis-quotes.json`, `data/jarvis-invoices.json`, `data/jarvis-enquiries.json`, `data/jarvis-errands.json`, `data/jarvis-business-settings.json` |

`notesAndEvidence`, `orchestration` and `quoteAggregate` are **not covered
yet**, so **every archive written today is `completeness: partial`** and is
refused by the full-recovery restore path. That is the honest state, not an
exclusion: the manifest lists the three groups as absent and claims no recovery
method for them.

Coverage is now the _only_ thing standing between an archive and `complete`.
Every archive `export-v4` writes has already been restored into an isolated
directory and read back, and carries the resulting per-group digests in
`manifest.verification`. When the remaining three groups land, archives become
`complete` on their own — nothing further has to be switched on. Until then,
`verify-v4` and `restore-v4 --allow-partial` report which groups were verified
alongside which are absent.

## Commands

```
npm run backup -- export-v4 <file>
npm run backup -- verify-v4 <file>
npm run backup -- restore-v4 <file> <empty-destination-dir> [--allow-partial] [--resume]
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

`restore-v4` never merges and never overwrites. It classifies the destination
before writing anything, and each condition is refused by name:

| Destination                                                 | Result                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| does not exist                                              | reserved with an exclusive `mkdir`, restore proceeds     |
| holds a **completed** restore                               | refused — restoring again would overwrite recovered data |
| holds an **interrupted** restore of **this** archive        | refused, naming `--resume` as the recovery               |
| holds an **interrupted** restore of a **different** archive | refused                                                  |
| exists but was **not** written by a restore                 | refused, never touched                                   |
| a symbolic link                                             | refused                                                  |
| overlaps the live Jarvis data directory                     | refused                                                  |

After writing, both readers must agree: every document is re-read strictly _and_
through a fresh ordinary runtime store, and any difference fails the restore
rather than reporting success.

The restored directory also carries a copy of the archive's `manifest.json`, so
it is self-describing and a partial restore cannot later be mistaken for a
recovery image.

### Interrupted restores are recoverable

Two markers make an interruption a named, recoverable condition rather than a
directory an operator has to reason about:

- `.jarvis-archive-v4-in-progress.json` is written **before the first document**
  and removed **only after** the restore has verified and completed. It records
  the archive's fingerprint and every file the restore intends to write.
- `.jarvis-archive-v4-complete.json` is written **last**, after verification
  passes.

So a failure at _any_ point — including after every document is on disk and
correct, but before the completion marker — leaves a directory that is
unmistakably incomplete and says so.

```
npm run backup -- restore-v4 archive.json /srv/restore --allow-partial --resume
```

`--resume` validates every existing output file against the exact bytes derived
from the archive, retains matching files, and writes only missing files:

- The expected filenames and serialization come from the **archive**, not from
  the marker. A forged marker cannot expand that scope.
- Any unexpected entry, non-regular or hard-linked file, non-private permissions, changed bytes or truncated output makes
  resume refuse before writing anything. Existing data and manifest files are
  never deleted during resume. Preserve and inspect refused output; use a fresh
  isolated destination when the incomplete files cannot be verified.
- The marker must identify this same archive and its exact planned file list, and pass the same private-file and byte checks. Retained files must be owner-readable with no group/other access, matching the existing secure token-store policy. Fresh files are created with mode `0600`.
- Live-directory exclusion compares both lexical and physical paths, resolving
  existing ancestors so symlink aliases cannot conceal overlap.

Keep the destination and its ancestors exclusive to this restore until verification
finishes. These checks do not protect against another process concurrently changing
the filesystem under the restore.

Recovery is always an explicit operator decision — a plain retry never resumes
silently.

### Proving it

`npm run restore-drill` runs the whole interrupted-restore matrix and prints a
recorded result table: for each of the fourteen files, it interrupts the restore
after that file, then checks the destination was left incomplete, that a plain
retry is refused, that `--resume` completes, and that the recovered directory is
**byte-identical** to an uninterrupted restore of the same archive. It also
checks the source dataset is unchanged.

The drill builds its own dataset, captures its own archive and works entirely
inside a temporary directory it creates and removes. It never reads the live
Jarvis data directory and performs no external effect, so it is safe to run in
any clean development environment.

### External effects

A v4 restore performs **no external effect at all**: it writes JSON documents
into the directory it reserved and nothing else — no network call, no message, no
approval, no lease. Duplicate external effects are therefore not merely avoided
but impossible at this stage. That changes when orchestration state and delivery
receipts arrive; the inertness rules for those (a restored receipt must not renew
an approval, reactivate a lease, or authorise execution) apply then.

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
