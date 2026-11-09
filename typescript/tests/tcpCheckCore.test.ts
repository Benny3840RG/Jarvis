import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeAllowlistDigest,
  computeSpecialUseTableDigest,
  evaluateFreshness,
  isAllowlisted,
  isSpecialUse,
  parseAllowlist,
  parseCanonicalAddress,
  TRUSTED_SPECIAL_USE_TABLE_DIGEST,
  verifySpecialUseTable,
} from "../src/security/tcpCheck/index.js";

describe("parseCanonicalAddress", () => {
  it("accepts canonical IPv4 and IPv6", () => {
    assert.equal(parseCanonicalAddress("8.8.8.8")?.version, 4);
    assert.equal(parseCanonicalAddress("2606:4700:4700::1111")?.version, 6);
    assert.equal(parseCanonicalAddress("::1")?.canonical, "::1");
  });

  it("rejects non-canonical spellings rather than rewriting them", () => {
    for (const bad of [
      "08.8.8.8", // leading zero
      "8.8.8.256", // out of range
      "1.2.3", // too few octets
      "1.2.3.4.5", // too many
      "0x8.8.8.8", // hex octet
      "2606:4700:4700:0::1111", // non-minimal zero group
      "2606:4700:4700::1111%eth0", // zone id
      "[::1]", // brackets
      "::ffff:1.2.3.4", // embedded IPv4
      "2001:DB8::1", // uppercase
      "1::2::3", // double ::
      "", // empty
    ]) {
      assert.equal(parseCanonicalAddress(bad), null, `should reject ${bad}`);
    }
  });

  it("round-trips bytes for a known IPv4 address", () => {
    assert.deepEqual([...(parseCanonicalAddress("192.168.1.1")?.bytes ?? [])], [192, 168, 1, 1]);
  });
});

describe("isSpecialUse", () => {
  it("denies loopback, private, link-local, documentation, and reserved ranges", () => {
    for (const denied of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.5",
      "192.168.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "192.0.2.5", // TEST-NET-1
      "240.0.0.1", // reserved
      "::1",
      "fe80::1",
      "fc00::1",
      "2001:db8::1",
      "ff02::1",
      "::ffff:7f00:1", // IPv4-mapped range
    ]) {
      const address = parseCanonicalAddress(denied);
      assert.ok(address, `parse ${denied}`);
      assert.equal(isSpecialUse(address!), true, `${denied} must be special-use`);
    }
  });

  it("does not deny ordinary public addresses just outside the ranges", () => {
    for (const allowedByTable of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "2606:4700:4700::1111"]) {
      const address = parseCanonicalAddress(allowedByTable);
      assert.ok(address);
      assert.equal(isSpecialUse(address!), false, `${allowedByTable} must not be special-use`);
    }
  });

  it("neighbours just outside a boundary are not special-use", () => {
    // 100.64.0.0/10 spans 100.64–100.127; 100.128.0.0 is outside.
    assert.equal(isSpecialUse(parseCanonicalAddress("100.128.0.0")!), false);
    assert.equal(isSpecialUse(parseCanonicalAddress("11.0.0.0")!), false);
  });
});

describe("special-use table integrity", () => {
  it("matches the independently trusted anchor", () => {
    assert.equal(computeSpecialUseTableDigest(), TRUSTED_SPECIAL_USE_TABLE_DIGEST);
    assert.doesNotThrow(() => verifySpecialUseTable());
  });
});

describe("parseAllowlist / isAllowlisted", () => {
  it("accepts a canonical entry and enforces (ip, port) exactly", () => {
    const result = parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [443, 53] }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(isAllowlisted(result.allowlist, "8.8.8.8", 443), true);
    assert.equal(isAllowlisted(result.allowlist, "8.8.8.8", 80), false); // port not approved
    assert.equal(isAllowlisted(result.allowlist, "9.9.9.9", 443), false); // host not listed
    assert.deepEqual(result.allowlist.entries[0]!.ports, [53, 443]); // sorted
  });

  it("treats an empty entry list as valid deny-all", () => {
    const result = parseAllowlist({ entries: [] });
    assert.equal(result.ok, true);
  });

  it("fails closed on non-canonical ip, bad ports, and duplicates", () => {
    assert.equal(parseAllowlist({ entries: [{ ip: "08.8.8.8", ports: [443] }] }).ok, false);
    assert.equal(parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [0] }] }).ok, false);
    assert.equal(parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [70000] }] }).ok, false);
    assert.equal(parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [] }] }).ok, false);
    assert.equal(
      parseAllowlist({
        entries: [
          { ip: "8.8.8.8", ports: [443] },
          { ip: "8.8.8.8", ports: [53] },
        ],
      }).ok,
      false,
    );
    assert.equal(parseAllowlist({}).ok, false);
  });
});

describe("computeAllowlistDigest", () => {
  it("is deterministic and changes with the allowlist", () => {
    const a = parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [443] }] });
    const b = parseAllowlist({ entries: [{ ip: "8.8.8.8", ports: [443, 53] }] });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(computeAllowlistDigest(a.allowlist), computeAllowlistDigest(a.allowlist));
    assert.notEqual(computeAllowlistDigest(a.allowlist), computeAllowlistDigest(b.allowlist));
  });
});

describe("evaluateFreshness", () => {
  const snapshotDate = "2026-11-07T00:00:00Z";
  const day = 24 * 60 * 60 * 1000;
  const snapshotMs = Date.parse(snapshotDate);

  it("is fresh within the bound and stale past it", () => {
    assert.equal(
      evaluateFreshness({ snapshotDate, nowMs: snapshotMs + day, maxAgeMs: 30 * day }).fresh,
      true,
    );
    assert.equal(
      evaluateFreshness({ snapshotDate, nowMs: snapshotMs + 60 * day, maxAgeMs: 30 * day }).reason,
      "stale",
    );
  });

  it("fails closed on future, invalid, or bad-bound inputs", () => {
    assert.equal(
      evaluateFreshness({ snapshotDate, nowMs: snapshotMs - day, maxAgeMs: 30 * day }).reason,
      "future-snapshot",
    );
    assert.equal(
      evaluateFreshness({ snapshotDate: "not-a-date", nowMs: snapshotMs, maxAgeMs: day }).reason,
      "invalid-snapshot",
    );
    assert.equal(
      evaluateFreshness({ snapshotDate, nowMs: snapshotMs, maxAgeMs: 0 }).reason,
      "invalid-bound",
    );
  });
});
