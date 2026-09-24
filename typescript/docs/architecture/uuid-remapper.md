# UuidRemapper

Owned helper for Jarvis restores that cannot keep the source id. It is not a
backup format, and it does not change archive v4.

## What it does

`UuidRemapper` (`src/backup/uuidRemapper.ts`) remembers `oldId → newId`.

- `remap(oldId)` mints on first sight (`createId`, default `randomUUID`) and
  returns that same id on every later call. Tests pass a deterministic
  `createId`.
- `bind(oldId, newId)` records an id the destination store already assigned.
  A conflicting pair is refused.
- `remapFields` / `remapArrayFields` rewrite named fields on a shallow copy.
  Any field not in the list is copied unchanged, even when its text equals an
  old id.
- `translateKnown` walks nested objects and arrays and replaces a string only
  when the map already contains it. It does not mint. One pass: `a → b` and
  `b → c` turns the value `a` into `b`.

## Where restore uses it

JSON `restoreSnapshotIntoEmpty` mints task and reminder ids with two remappers.
A task id may equal a reminder id; each row keeps its own new id, and assistant
state keeps the reminder's id when the strings collide.

v3 `restoreMemoryStores` binds each new build id, then looks up
`buildLogs.buildId` and `upgrades.buildId`. An unknown build id still fails
the restore. Verification of assistant state uses `translateKnown` on the same
old→new maps the provider returned.

Empty-target refusal and the confirm flags are unchanged.

## What it does not restore

`src/backup/crossDomainReferences.ts` lists foreign keys for properties,
projects, quotes, invoices, enquiries, and errands. Nothing in the v3 or v4
restore path calls it yet.

- v3 archives still omit those domains.
- v4 writes the JSON business records with logical ids preserved.
- `notesAndEvidence` is not sealed in either archive. The isolated S4 adapter
  preserves logical note, component, and risk ids and does not call
  `UuidRemapper`.
- Invoice `payments[].id` and enquiry `attachmentRefs` are not in the field list.

A later minting restore has to `remap` or `bind` every primary id on one
remapper, then call `remapCrossDomainReferences`, and refuse a foreign key that
was never a restored record. That slice is still open.
