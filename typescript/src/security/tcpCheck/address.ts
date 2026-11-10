// Canonical IP-literal parsing for the Stage 3 `security:tcp-check` capability
// (design: docs/design/issue-732-stage3-authorised-diagnostics.md). Exactly one
// textual form is accepted per address: a non-canonical spelling is **rejected,
// never rewritten**, so the same canonical byte form is used identically for
// validation, the deny/allow checks, the fingerprint, and (later) the socket
// target. There is no DNS and no fallback. This module performs **no I/O**.
//
// The strategy that guarantees "one textual form": parse to raw bytes, re-emit
// the canonical string from those bytes, and require the input to equal it
// byte-for-byte. That rejects leading zeros, uppercase hex, non-minimal `::`
// compression, and every other non-canonical spelling without rewriting.

/** A validated address in its single canonical form. */
export interface CanonicalAddress {
  readonly version: 4 | 6;
  /**
   * 4 bytes for IPv4, 16 for IPv6. A **frozen** array, so classification cannot
   * later be made to diverge from {@link CanonicalAddress.canonical} by mutating
   * the parsed value in place (an internal integrity requirement).
   */
  readonly bytes: readonly number[];
  /** The canonical textual form; always equal to the accepted input. */
  readonly canonical: string;
}

/** Build a frozen address value whose bytes array cannot be mutated. */
function freezeAddress(version: 4 | 6, bytes: number[], canonical: string): CanonicalAddress {
  return Object.freeze({ version, bytes: Object.freeze(bytes), canonical });
}

const IPV4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

function parseIpv4(input: string): CanonicalAddress | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!IPV4_OCTET.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[index] = value;
  }
  // Canonicalisation here is implicit (the octet grammar forbids leading zeros),
  // but we still compare to be explicit that the input is the canonical form.
  const canonical = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  return canonical === input ? freezeAddress(4, bytes, canonical) : null;
}

function hextetsFromStrings(groups: readonly string[]): number[] | null {
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!IPV6_GROUP.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

/** Parse an IPv6 literal (no embedded IPv4, zone IDs, or brackets) to 8 hextets. */
function parseIpv6Hextets(input: string): number[] | null {
  // Embedded/compat/mapped IPv4 textual forms and zone IDs/brackets are rejected
  // outright; IPv4 targets must be supplied as IPv4 literals.
  if (/[.%[\]]/.test(input)) return null;
  if (input.includes(":::")) return null;

  const halves = input.split("::");
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const left = halves[0] === "" ? [] : halves[0]!.split(":");
    const right = halves[1] === "" ? [] : halves[1]!.split(":");
    const missing = 8 - (left.length + right.length);
    // "::" must stand for at least one all-zero group.
    if (missing < 1) return null;
    const filled = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
    return hextetsFromStrings(filled);
  }

  return hextetsFromStrings(input.split(":"));
}

/** Longest run (>=2) of zero hextets is compressed to `::`, leftmost wins (RFC 5952). */
function canonicalIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < 8; index += 1) {
    if (hextets[index] === 0) {
      if (runStart < 0) runStart = index;
      runLength += 1;
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  const hex = (value: number): string => value.toString(16);
  if (bestLength < 2) return hextets.map(hex).join(":");
  const head = hextets.slice(0, bestStart).map(hex).join(":");
  const tail = hextets
    .slice(bestStart + bestLength)
    .map(hex)
    .join(":");
  return `${head}::${tail}`;
}

function parseIpv6(input: string): CanonicalAddress | null {
  const hextets = parseIpv6Hextets(input);
  if (hextets === null) return null;
  const canonical = canonicalIpv6(hextets);
  if (canonical !== input) return null;
  const bytes: number[] = new Array(16).fill(0);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = (hextets[index]! >>> 8) & 0xff;
    bytes[index * 2 + 1] = hextets[index]! & 0xff;
  }
  return freezeAddress(6, bytes, canonical);
}

/**
 * Parse an IP literal into its single canonical form, or return `null` if the
 * input is not exactly the canonical spelling of a valid IPv4 or IPv6 address.
 * Never rewrites; never resolves names.
 */
export function parseCanonicalAddress(input: string): CanonicalAddress | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input.includes(":") ? parseIpv6(input) : parseIpv4(input);
}
