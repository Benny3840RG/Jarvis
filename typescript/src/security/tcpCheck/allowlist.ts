// The reviewed `(ip, port)` target allowlist for `security:tcp-check` (design:
// "Approved parameters"). Explicit IP literals, each with an explicit set of
// approved integer ports; default-deny and empty by default; never runtime- or
// prompt-mutable. This module validates an already-parsed value (no file I/O)
// and provides the permit gate. An address is permitted only if it is **not** in
// the special-use table AND matches an `(ip, port)` entry here (both gates are
// mandatory and checked elsewhere; this module owns only the allow gate).

import { parseCanonicalAddress } from "./address.js";

/** Lowest and highest assignable TCP ports (obligation: port range 1–65535). */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

export interface AllowlistEntry {
  /** Canonical IP literal. */
  readonly ip: string;
  /** Sorted, de-duplicated approved ports. */
  readonly ports: readonly number[];
}

export interface Allowlist {
  readonly entries: readonly AllowlistEntry[];
}

export type AllowlistParseResult =
  | { readonly ok: true; readonly allowlist: Allowlist }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed allowlist document into a canonical `Allowlist`, or report
 * why it is rejected. Fail-closed: anything not strictly valid is refused. An
 * empty entry list is valid and means deny-all.
 */
export function parseAllowlist(raw: unknown): AllowlistParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "allowlist must be an object" };
  const { entries } = raw;
  if (!Array.isArray(entries)) return { ok: false, reason: "allowlist.entries must be an array" };

  const seenIps = new Set<string>();
  const parsed: AllowlistEntry[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) return { ok: false, reason: "each allowlist entry must be an object" };
    const { ip, ports } = entry;
    if (typeof ip !== "string") return { ok: false, reason: "entry.ip must be a string" };

    const canonical = parseCanonicalAddress(ip);
    if (canonical === null) {
      return { ok: false, reason: `entry.ip is not a canonical IP literal: ${ip}` };
    }
    if (canonical.canonical !== ip) {
      return { ok: false, reason: `entry.ip is not in canonical form: ${ip}` };
    }
    if (seenIps.has(ip)) return { ok: false, reason: `duplicate allowlist entry for ${ip}` };
    seenIps.add(ip);

    if (!Array.isArray(ports) || ports.length === 0) {
      return { ok: false, reason: `entry.ports for ${ip} must be a non-empty array` };
    }
    const seenPorts = new Set<number>();
    for (const port of ports) {
      if (typeof port !== "number" || !Number.isInteger(port)) {
        return { ok: false, reason: `entry.ports for ${ip} must be integers` };
      }
      if (port < MIN_PORT || port > MAX_PORT) {
        return { ok: false, reason: `port ${port} for ${ip} is outside ${MIN_PORT}–${MAX_PORT}` };
      }
      if (seenPorts.has(port)) return { ok: false, reason: `duplicate port ${port} for ${ip}` };
      seenPorts.add(port);
    }

    parsed.push({ ip, ports: [...seenPorts].sort((a, b) => a - b) });
  }

  parsed.sort((a, b) => (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0));
  return { ok: true, allowlist: { entries: parsed } };
}

/** True iff `(ip, port)` matches an allowlist entry exactly. Default-deny. */
export function isAllowlisted(allowlist: Allowlist, ip: string, port: number): boolean {
  const entry = allowlist.entries.find((candidate) => candidate.ip === ip);
  return entry !== undefined && entry.ports.includes(port);
}
