// The compiled active policy the `security:tcp-check` mediator enforces at
// connect time. Its running value *is* the policy of record (Decision 0): the
// reviewed allowlist, the vendored special-use table's snapshot date and
// freshness bound, and the monotonic policy epoch. No I/O.

import type { Allowlist } from "./allowlist.js";

export interface PolicyView {
  readonly allowlist: Allowlist;
  /** ISO-8601 snapshot date of the vendored special-use table. */
  readonly snapshotDate: string;
  /** Reviewed freshness bound in ms. */
  readonly maxAgeMs: number;
  /** Monotonic policy epoch, advanced on any activation. */
  readonly policyEpoch: number;
}
