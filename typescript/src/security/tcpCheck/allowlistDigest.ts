// Policy-identity digest for `security:tcp-check` (design R3). `allowlistDigest`
// is a SHA-256 over the canonical serialisation of the loaded allowlist **and**
// the full contents of the vendored special-use table, so any edit to either —
// including a single table row — changes the digest. It is computed server-side
// only; a caller-supplied value is never honoured. No I/O.

import { canonicalJson } from "../../actions/canonicalJson.js";
import { sha256Hex } from "../../actions/sha256.js";

import type { Allowlist } from "./allowlist.js";
import { serializeSpecialUseTable } from "./specialUseTable.js";

/** Deterministic serialisation of the allowlist contents. */
export function serializeAllowlist(allowlist: Allowlist): string {
  return canonicalJson({
    entries: allowlist.entries.map((entry) => ({ ip: entry.ip, ports: [...entry.ports] })),
  });
}

/**
 * SHA-256 over allowlist contents + full special-use table contents. Binds the
 * policy identity that an approval authorises; folds in the table so a table
 * change is reflected in the digest (the trusted anchor separately establishes
 * the table is the reviewed one).
 */
export function computeAllowlistDigest(allowlist: Allowlist): string {
  return sha256Hex(
    canonicalJson({
      allowlist: serializeAllowlist(allowlist),
      specialUseTable: serializeSpecialUseTable(),
    }),
  );
}
