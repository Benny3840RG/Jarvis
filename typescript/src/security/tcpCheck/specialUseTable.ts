// Vendored, dated special-use address table for `security:tcp-check` (design R2).
// Derived from the IANA IPv4 and IPv6 Special-Purpose Address Registries
// (RFC 6890 and its updates). This table is the policy floor that runs **before
// and independent of** the allowlist: an address in any entry here is denied,
// and absence from the table is *not* permission. Performs no I/O.
//
// Integrity is checked against an independently trusted anchor committed in a
// separate file (`specialUseTableAnchor.ts`) — hashing the table into its own
// digest cannot detect a table edited together with its declared digest, so the
// anchor is the trust root and the loader fails closed on mismatch.

import { canonicalJson } from "../../actions/canonicalJson.js";
import { sha256Hex } from "../../actions/sha256.js";

import { parseCanonicalAddress, type CanonicalAddress } from "./address.js";
import { TRUSTED_SPECIAL_USE_TABLE_DIGEST } from "./specialUseTableAnchor.js";

export interface SpecialUseEntry {
  readonly base: string;
  readonly prefix: number;
  readonly family: 4 | 6;
  readonly label: string;
}

/** IANA special-purpose registries snapshot date (ISO 8601, UTC). */
export const SPECIAL_USE_TABLE_SNAPSHOT_DATE = "2026-11-09";

// Ordered, stable list. Any edit here must be matched by a new anchor digest in
// specialUseTableAnchor.ts within the same reviewed PR, or loading fails closed.
// Deeply frozen on export so the shared policy floor cannot be extended at runtime.
const SPECIAL_USE_TABLE_ENTRIES: readonly SpecialUseEntry[] = [
  { base: "0.0.0.0", prefix: 8, family: 4, label: "this-host-on-this-network" },
  { base: "10.0.0.0", prefix: 8, family: 4, label: "private-use" },
  { base: "100.64.0.0", prefix: 10, family: 4, label: "shared-address-space-cgn" },
  { base: "127.0.0.0", prefix: 8, family: 4, label: "loopback" },
  { base: "169.254.0.0", prefix: 16, family: 4, label: "link-local" },
  { base: "172.16.0.0", prefix: 12, family: 4, label: "private-use" },
  { base: "192.0.0.0", prefix: 24, family: 4, label: "ietf-protocol-assignments" },
  { base: "192.0.2.0", prefix: 24, family: 4, label: "documentation-test-net-1" },
  { base: "192.31.196.0", prefix: 24, family: 4, label: "as112-v4" },
  { base: "192.52.193.0", prefix: 24, family: 4, label: "amt" },
  { base: "192.88.99.0", prefix: 24, family: 4, label: "6to4-relay-anycast-deprecated" },
  { base: "192.168.0.0", prefix: 16, family: 4, label: "private-use" },
  { base: "192.175.48.0", prefix: 24, family: 4, label: "direct-delegation-as112" },
  { base: "198.18.0.0", prefix: 15, family: 4, label: "benchmarking" },
  { base: "198.51.100.0", prefix: 24, family: 4, label: "documentation-test-net-2" },
  { base: "203.0.113.0", prefix: 24, family: 4, label: "documentation-test-net-3" },
  { base: "224.0.0.0", prefix: 4, family: 4, label: "multicast" },
  { base: "240.0.0.0", prefix: 4, family: 4, label: "reserved-future-use" },
  { base: "255.255.255.255", prefix: 32, family: 4, label: "limited-broadcast" },
  { base: "::", prefix: 96, family: 6, label: "ipv4-compatible-deprecated" },
  { base: "::1", prefix: 128, family: 6, label: "loopback" },
  { base: "::", prefix: 128, family: 6, label: "unspecified" },
  { base: "::ffff:0:0", prefix: 96, family: 6, label: "ipv4-mapped" },
  { base: "64:ff9b::", prefix: 96, family: 6, label: "nat64-well-known" },
  { base: "64:ff9b:1::", prefix: 48, family: 6, label: "nat64-local-use" },
  { base: "100::", prefix: 64, family: 6, label: "discard-only" },
  { base: "2001::", prefix: 23, family: 6, label: "ietf-protocol-assignments" },
  { base: "2001::", prefix: 32, family: 6, label: "teredo" },
  { base: "2001:1::1", prefix: 128, family: 6, label: "port-control-protocol-anycast" },
  { base: "2001:2::", prefix: 48, family: 6, label: "benchmarking" },
  { base: "2001:3::", prefix: 32, family: 6, label: "amt" },
  { base: "2001:4:112::", prefix: 48, family: 6, label: "as112-v6" },
  { base: "2001:10::", prefix: 28, family: 6, label: "orchid-deprecated" },
  { base: "2001:20::", prefix: 28, family: 6, label: "orchidv2" },
  { base: "2001:db8::", prefix: 32, family: 6, label: "documentation" },
  { base: "2002::", prefix: 16, family: 6, label: "6to4" },
  { base: "2620:4f:8000::", prefix: 48, family: 6, label: "direct-delegation-as112-v6" },
  { base: "fc00::", prefix: 7, family: 6, label: "unique-local" },
  { base: "fe80::", prefix: 10, family: 6, label: "link-local-unicast" },
  { base: "ff00::", prefix: 8, family: 6, label: "multicast" },
];

export const SPECIAL_USE_TABLE: readonly SpecialUseEntry[] = Object.freeze(
  SPECIAL_USE_TABLE_ENTRIES.map((entry) => Object.freeze({ ...entry })),
);

interface ResolvedEntry extends SpecialUseEntry {
  readonly bytes: readonly number[];
}

function resolveEntries(): readonly ResolvedEntry[] {
  return SPECIAL_USE_TABLE.map((entry) => {
    const parsed = parseCanonicalAddress(entry.base);
    if (parsed === null || parsed.version !== entry.family) {
      throw new Error(`Special-use table has a non-canonical base: ${entry.base}`);
    }
    const bits = entry.family === 4 ? 32 : 128;
    if (!Number.isInteger(entry.prefix) || entry.prefix < 0 || entry.prefix > bits) {
      throw new Error(`Special-use table has an invalid prefix for ${entry.base}/${entry.prefix}`);
    }
    return { ...entry, bytes: parsed.bytes };
  });
}

const RESOLVED_ENTRIES = resolveEntries();

function withinPrefix(
  address: readonly number[],
  base: readonly number[],
  prefix: number,
): boolean {
  let remaining = prefix;
  for (let index = 0; index < address.length && remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address[index]! & mask) !== (base[index]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** True if the address falls in any special-use range (the mandatory deny gate). */
export function isSpecialUse(address: CanonicalAddress): boolean {
  for (const entry of RESOLVED_ENTRIES) {
    if (entry.family !== address.version) continue;
    if (withinPrefix(address.bytes, entry.bytes, entry.prefix)) return true;
  }
  return false;
}

/** Deterministic serialisation of the table contents (what the digest covers). */
export function serializeSpecialUseTable(): string {
  return canonicalJson({
    snapshotDate: SPECIAL_USE_TABLE_SNAPSHOT_DATE,
    entries: SPECIAL_USE_TABLE.map((entry) => ({
      base: entry.base,
      prefix: entry.prefix,
      family: entry.family,
      label: entry.label,
    })),
  });
}

/** SHA-256 over the full table contents; folded into `allowlistDigest` (R3). */
export function computeSpecialUseTableDigest(): string {
  return sha256Hex(serializeSpecialUseTable());
}

/**
 * Verify the table against the independently trusted anchor. Fail-closed: throws
 * on mismatch so no allowlist use proceeds against an unverified table.
 */
export function verifySpecialUseTable(): void {
  const actual = computeSpecialUseTableDigest();
  if (actual !== TRUSTED_SPECIAL_USE_TABLE_DIGEST) {
    throw new Error(
      "Special-use table integrity check failed: computed digest does not match the trusted anchor " +
        "(specialUseTableAnchor.ts). Refusing to use the table (deny-all).",
    );
  }
}
