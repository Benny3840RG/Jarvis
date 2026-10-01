# JSON stale-lock recovery claims

`JsonFileLock` coordinates cooperating processes on one host. A valid primary
lock belongs to its recorded process while that process is alive. Recovering a
dead owner's lock requires a separate election for that exact lock generation.

## Complete claims before election

A recovery claim is written into a private, exclusive temporary file, synced
and closed, then published with a non-replacing hard link. A contender therefore
sees either no published claim or a complete immutable owner record. Temporary
claim filenames are not eligible election generations.

A failed election removes only its own temporary file, never another claimant's
published record. A complete claim whose process has exited permits election
of the next generation. A claim with a live owner blocks other reclaimers.

An aged malformed recovery claim does not prove that its owner has died. It
could belong to a suspended living process, so automatic takeover is refused.
This differs from the existing compatibility recovery of an old malformed
primary JSON lock, which is unchanged. Concurrent writers must run compatible
locking protocols; this is not protection against arbitrary external file edits.

## Failed removal keeps ownership

After election, the reclaimer re-reads the primary lock and checks its exact
generation. It releases its claim only when the old generation is gone, has
changed, or was successfully removed. On an unlink or verification error it
retains the claim rather than permit election through a recycled claim path.

A retained live-owner claim intentionally blocks automatic retry. Investigate
the I/O fault and quiesce the writer before recovery. After the owner process
has genuinely exited, another process can elect the next generation. Malformed
claims need operator investigation; do not delete sidecars under active writers.
Crashed predecessor claims may remain as recovery evidence.

## Regression evidence and limits

`tests/jsonFileLockClaims.test.ts` stages a paused claim write, competing
reclamation and a delayed unlink through the public `run()` boundary. It
requires that only one writer enters and only one reclaimer removes the stale
lock. Other cases cover malformed claims, retained ownership on unlink failure,
recovery of a dead claim owner and failed-publication cleanup.

The tests cover controlled process/file interleavings, not a commissioned host
power-loss drill, multi-host locking, PID-reuse availability or production
approval. File publication durability is covered separately in
[atomic JSON durability](atomic-json-durability.md).
