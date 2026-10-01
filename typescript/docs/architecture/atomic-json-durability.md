# Atomic JSON publication durability

`src/persistence/atomicJsonFile.ts` publishes private JSON for the core and
business stores. Callers still own writer coordination through `JsonFileLock`.
This primitive does not supply a second lock or change any persisted schema.

## Publication order

The destination is resolved before asynchronous work. The publisher creates an
exclusive `0o600` temporary file beside it, writes the JSON, syncs the file,
closes it, and renames it over the destination. Only then does it sync the
containing directory.

When recursive directory creation reports a newly created ancestor, directory
sync continues bottom-up through the existing parent of that first new
ancestor. Syncing only the leaf would leave the new directory entries outside
the durability boundary. For an already-existing directory, only that directory
needs syncing.

## Errors and platform limits

On POSIX systems, failures opening or syncing a directory are propagated,
including `EPERM`, `EINVAL`, `EISDIR`, `EIO` and `ENOSPC`. The publisher must not
report success after those failures.

The existing compatibility fallback for `EPERM`, `EINVAL` and `EISDIR` is limited
to Windows, where directory sync remains best-effort. Other failures still
propagate. A simulated Windows error-path test is not native Windows filesystem
commissioning.

A failure after rename leaves the complete published destination in place and
rejects the write. Callers must inspect or reconcile that result before retrying
non-idempotent work; rejection does not mean no write happened. Cleanup removes
only the temporary file and closes acquired handles. It does not delete the
published destination to simulate a rollback.

## Verification scope

`tests/atomicJsonFile.test.ts` covers file-sync/rename/directory-sync order,
publication on failure, private permissions, temporary-file cleanup, directory
handle cleanup, newly created ancestor entries, relative destinations and the
bounded Windows fallback.

These tests verify ordering and injected failures. They do not prove a physical
power-loss recovery drill, storage-device behaviour, production readiness or
full archive-v4 recovery. Filesystem and storage support still bound durability.
Stale-lock claim safety is covered separately in
[JSON recovery claims](json-lock-claims.md), under the same issue #548.
