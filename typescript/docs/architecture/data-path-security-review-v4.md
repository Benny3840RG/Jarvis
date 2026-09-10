# Data-path security review — archive v4 (A5 follow-up)

The A5 review (`data-path-security-review.md`) was taken against `main` @
`612d596`. Archive v4 has since added a substantial new data path — strict
readers for fourteen source documents, an archive file format, and an isolated
restore — which that review predates and does not cover.

This document reviews that new surface on the same four boundaries
(**ownership**, **parsing**, **mutation**, **output**), records what was
remediated, and states the gaps that remain. Findings are validated against the
code and, where a claim is empirical, against a measurement recorded here.

Scope: `src/backup/v4/**`, `src/backup/archiveManifest.ts`,
`src/backup/strictValues.ts`, `src/tools/runBackupV4.ts`,
`src/tools/runRestoreDrill.ts`.

## Findings remediated here

### V1 — The archive size bound stopped the backup working as the business grew

`MAX_ARCHIVE_BYTES` was 10 MiB, chosen when a v4 archive held only the core and
memory groups. Once the business record group landed, the same number bounded a
much larger dataset — and there was no way to raise it.

Measured: 4,000 invoice-sized records produce a 2.4 MB archive; **20,000 exceed
the 10 MiB bound and the export refuses outright.** The refusal came after the
whole capture had been done, and said "refusing to write a truncated file",
which is not what was happening — nothing would have been truncated.

A backup that silently stops being possible as the data grows is not a safety
property. The operator finds out at the moment they need it, and has no move.

**Fix:** one bound in `src/backup/v4/limits.ts`, defaulting to 64 MiB and
overridable with `JARVIS_ARCHIVE_MAX_BYTES` (validated: a whole number of bytes
between 1 MiB and 2 GiB). Every message the bound produces names the override,
so a refusal is never a dead end.

### V2 — Source files were read with no bound at all

The archive had a size cap; the fourteen **source** documents it is built from
had none. A large or hostile `data/jarvis-*.json` was read wholly into memory,
and the failure — if any — came later, at archive-write time, after the whole
capture had been paid for.

**Fix:** `readRawJson` stats before reading and applies the _same_ bound. One
number on both sides, because a source that can be read but never written to an
archive is as useless as an archive that can be written but not read back — and
the read side is where the runaway-read risk actually is.

### V3 — Restore markers were read with no bound

`inspectDestination` reads `.jarvis-archive-v4-in-progress.json` and
`.jarvis-archive-v4-complete.json` from a directory the restore does not
necessarily own yet. Both are a handful of fields; neither was bounded.

**Fix:** 1 MiB cap (`MAX_MARKER_BYTES`). Anything larger is not a marker this
restore wrote, and refusing is how it finds that out without reading it.

### V4 — A store refusing a file escaped as a bare, contextless error

The capture reads each business domain through its own ordinary store as the
losslessness oracle. Some of those stores refuse a file outright: the business
settings store rejects text matching its credential patterns, which is a
**correct** refusal at a boundary the write path already enforces.

Verified: a settings file whose `paymentReferenceTemplate` contains
`api_key ABC` makes `JsonBusinessSettingsStore.get()` throw
`Error: Payment reference template must not contain credentials, tokens, or secrets.`
That escaped the capture untyped — no file path, no indication it came from the
backup, and not a `StrictBackupError`, so the CLI treated it as an unexpected
failure.

**Fix:** `readThroughRuntime` wraps every runtime store read and reports the
domain, the file, and why it stopped the capture: a restore would not be able to
load that file either.

### V5 — The archive-write exclusivity guard could surface untyped

`writeArchiveV4File` probes with `fs.access` and then relies on `fs.link` to
refuse an existing target. The probe is TOCTOU and always was; `link` is the
real guard. But a target created between the two produced a raw `EEXIST` rather
than the typed refusal the probe produces.

**Fix:** the `link` failure is now translated, so both paths refuse identically.
The comment states which of the two is load-bearing.

**Regression coverage:** `tests/backupV4Limits.test.ts` — the default and every
rejected override; a real four-year dataset well inside the default; the bound
named in both write and read refusals; a source file refused on size; an
oversized marker refused; a store refusal reported with its file and domain; and
the file modes below.

## Validated as sound

| Boundary                                           | Mechanism that makes it sound                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing — closed schemas                           | Every v4 record parser rejects unknown fields (`assertNoUnknownKeys`); an unexpected key is a hard error, never silently discarded, at both document and record level.                                                                                                                                                |
| Parsing — no coercion                              | `strictValues.ts` never trims, defaults, or coerces. A value is what a faithfully-stored record holds or it is rejected, so nothing can be quietly rewritten between capture and restore.                                                                                                                             |
| Parsing — symlinks                                 | Source/archive final symlinks are refused through no-follow reads. Restore refuses a symlink destination, resolves existing ancestors for physical live-path exclusion, and uses no-follow handles when checking retained output. Concurrent filesystem modification is outside the exclusive-directory precondition. |
| Parsing — prototype safety                         | `assertJsonSafe` rejects non-plain objects, circular references and non-finite numbers before any state object enters an archive.                                                                                                                                                                                     |
| Mutation — archive writes                          | `0o600`, exclusive create (`wx`), temp-then-`link`; `link` refuses rather than replacing an existing target.                                                                                                                                                                                                          |
| Mutation — restore writes                          | Destination created `0o700` with a non-recursive exclusive `mkdir`; every document `0o600` and `wx`; `fsync` on files and directory.                                                                                                                                                                                  |
| Mutation — never touches live data                 | `assertDestinationNotLive` rejects lexical and physical overlap, including symlink aliases and names beginning with two dots. The restore uses the canonical destination; tests assert no writes within aliased live storage.                                                                                         |
| Mutation — quarantine cannot fire                  | The forgiving stores rename a malformed file aside on read. A backup must never trigger that, so every runtime store read happens strictly **after** the strict reader has accepted the file — asserted by a test that leaves a malformed source byte-identical after the capture aborts.                             |
| Mutation — bounded recovery                        | `--resume` checks archive-derived filenames and exact serialized bytes for every existing output before writing. Matching data/manifest files are retained; unexpected, changed or truncated files refuse the operation without deletion.                                                                             |
| Output — error messages carry locators, not values | Failures name a file, a field path and a record id. No parser interpolates the offending _value_; enum failures list the allowed set, not the rejected input.                                                                                                                                                         |
| Output — no external effect                        | A v4 restore performs no network call, no message, no approval and no lease. Duplicate external effects are impossible at this stage rather than avoided.                                                                                                                                                             |
| Ownership                                          | v4 is JSON-only and does not cross the Convex boundary, so the `requireOwner` surface reviewed in A5 is unchanged by it.                                                                                                                                                                                              |

### Sensitive content, handled by file mode

A v4 archive genuinely carries sensitive material: business settings hold
`bankName`, `accountName`, `bsb` and `accountNumber`. This is stated rather than
left implicit, because the protection is file permissions, not encryption.

Verified by test: the archive file is `0600`, the restored directory `0700`, and
every restored document `0600`. `verify-v4` and the drill materialise data under
`mkdtemp`, which creates its directory `0700`, so a world-writable `/tmp` does
not expose them.

## Recorded coverage gaps (not remediated here)

1. **Archives are not encrypted at rest.** Bank details in a `0600` file are
   protected from other users on the host and from nothing else — not a stolen
   disk, not a backup of the backup, not a copy moved off the machine. Whether
   that is acceptable is an owner decision, not one to settle in a review. If it
   is not, the place to fix it is the archive write path, once.
2. **TOCTOU on intermediate path components.** `O_NOFOLLOW` protects the final
   component of every path. A symlink _above_ a source or destination — an
   attacker-controlled parent directory — is not defeated by it. On a
   single-user host with a fixed data directory this is not reachable; it is
   recorded because a future deployment with a shared or configurable path would
   make it so. `realpath` on the parent would close it.
3. **`JARVIS_ARCHIVE_MAX_BYTES` is a memory bound, not a disk bound.** It caps
   what is read and what is serialised; it does not check free space at the
   destination. A restore that fills the disk fails partway and is recoverable
   by the marker contract, which is the right outcome, but the failure is an
   `ENOSPC` rather than a considered refusal.
4. **The forgiving store readers are unchanged.** v4 works around them by
   reading raw bytes and using them only as an oracle. At runtime the stores
   still drop invalid rows silently — an integrity concern tracked under A6, not
   fixed here, and not something the backup layer should fix on its behalf.
5. **Convex-backed groups are unreviewed.** Three of six required groups
   (`notesAndEvidence`, `orchestration`, `quoteAggregate`) are not yet
   implemented. Their data path — physical-id translation, blob export and
   receipt inertness — needs this same review when it lands.

## Handoff

Gaps 1 and 5 need decisions rather than code: gap 1 is an owner decision on
whether archives must be encrypted at rest; gap 5 waits on the Convex-backed
stages. Gaps 2 and 3 are recorded properties with named fixes, neither reachable
in the current single-user, fixed-path deployment. Gap 4 is bound to A6.

Nothing in this review is a completion claim. The remediations are covered by
tests; whether the coverage is sufficient is Jarvis's decision.
