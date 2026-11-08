// The compiled active policy the `security:tcp-check` mediator enforces at
// connect time. Its running value *is* the policy of record (Decision 0): the
// reviewed allowlist, the vendored special-use table's snapshot date and
// freshness bound, and the monotonic policy epoch. No I/O.

import type { Allowlist } from "./allowlist.js";

export interface PolicyView {
  readonly allowlist: Allowlist;
  /**
   * Reviewed freshness bound in ms. The snapshot DATE is NOT carried here — it is
   * read from the anchor-verified special-use table (`SPECIAL_USE_TABLE_SNAPSHOT_DATE`),
   * so a caller cannot substitute a fresher date than the actual table (Codex
   * round 4 #3).
   */
  readonly maxAgeMs: number;
  /** Monotonic policy epoch, advanced on any activation. */
  readonly policyEpoch: number;
}
