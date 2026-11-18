import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALLOWLIST, evaluateAudit } from "../scripts/check-audit.mjs";

type Via = string | { url?: string; title?: string; severity?: string };

function report(entries: Record<string, Via[]>) {
  return {
    vulnerabilities: Object.fromEntries(
      Object.entries(entries).map(([name, via]) => [name, { name, via }]),
    ),
  };
}

const PICOMATCH = {
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  title: "picomatch ReDoS",
  severity: "high",
};
const OTHER_HIGH = {
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  title: "Some other advisory",
  severity: "high",
};
const allowlist = new Map([
  ["GHSA-FC5Q-39XC-VJPF", { reason: "test", expires: "2026-12-02", devOnly: true }],
]);
const empty = report({});

describe("typescript audit gate", () => {
  it("passes a clean report", () => {
    assert.deepEqual(
      evaluateAudit({ full: empty, production: empty, today: "2026-11-18", allowlist }),
      [],
    );
  });

  it("tolerates an allowlisted dev-only advisory before it expires", () => {
    const full = report({ picomatch: [PICOMATCH], fdir: ["picomatch"] });
    assert.deepEqual(
      evaluateAudit({ full, production: empty, today: "2026-11-18", allowlist }),
      [],
    );
    assert.deepEqual(
      evaluateAudit({ full, production: empty, today: "2026-12-02", allowlist }),
      [],
    );
  });

  it("blocks any advisory that is not allowlisted", () => {
    const full = report({ picomatch: [PICOMATCH], other: [OTHER_HIGH] });
    const blocking = evaluateAudit({ full, production: empty, today: "2026-11-18", allowlist });
    assert.deepEqual(
      blocking.map((b) => [b.id, b.reason]),
      [["GHSA-AAAA-BBBB-CCCC", "not-allowlisted"]],
    );
  });

  it("blocks an allowlisted advisory once it expires", () => {
    const full = report({ picomatch: [PICOMATCH] });
    const blocking = evaluateAudit({ full, production: empty, today: "2026-12-03", allowlist });
    assert.deepEqual(
      blocking.map((b) => [b.id, b.reason]),
      [["GHSA-FC5Q-39XC-VJPF", "allowlist-expired"]],
    );
  });

  it("blocks a dev-only allowlisted advisory that reaches production dependencies", () => {
    const full = report({ picomatch: [PICOMATCH] });
    const production = report({ picomatch: [PICOMATCH] });
    const blocking = evaluateAudit({ full, production, today: "2026-11-18", allowlist });
    assert.deepEqual(
      blocking.map((b) => [b.id, b.reason]),
      [["GHSA-FC5Q-39XC-VJPF", "reaches-production"]],
    );
  });

  it("ignores low-severity advisories, as --audit-level=moderate did", () => {
    const full = report({ x: [{ ...OTHER_HIGH, severity: "low" }] });
    assert.deepEqual(
      evaluateAudit({ full, production: empty, today: "2026-11-18", allowlist }),
      [],
    );
  });

  it("treats an advisory with no severity as blocking", () => {
    const full = report({ x: [{ url: OTHER_HIGH.url }] });
    assert.equal(
      evaluateAudit({ full, production: empty, today: "2026-11-18", allowlist }).length,
      1,
    );
  });

  it("keeps every real allowlist entry dated, dev-only and at most 30 days long", () => {
    assert.ok(ALLOWLIST.size <= 3, "keep the allowlist short");
    for (const [id, entry] of ALLOWLIST) {
      assert.match(id, /^GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      assert.equal(entry.devOnly, true, `${id} must be dev-only`);
      assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(entry.reason.length > 40, `${id} needs a stated reason`);
      const days = (Date.parse(entry.expires) - Date.parse(entry.added)) / 86_400_000;
      assert.ok(days > 0 && days <= 30, `${id} expiry must be within 30 days of being added`);
    }
  });
});
