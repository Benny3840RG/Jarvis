import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Dependency audit gate for `typescript/` with a narrow, dated allowlist.
 *
 * Replaces the plain `npm audit --audit-level=moderate` CI step. It still fails
 * on every moderate-or-worse advisory, except one listed below, and an entry is
 * only tolerated while all three hold:
 *
 *   1. the advisory has no installable fixed version (say so in `reason`);
 *   2. it is reachable only through development dependencies -- the gate also
 *      audits the production tree (`npm audit --omit=dev`) and blocks if a
 *      dev-only entry appears there;
 *   3. today is on or before `expires` (at most 30 days after `added`). On
 *      expiry the gate fails again, forcing a fresh owner decision.
 *
 * Remove an entry as soon as a fixed version is available. Adding or renewing
 * an entry is an owner decision.
 */
export const ALLOWLIST = new Map([
  [
    "GHSA-FC5Q-39XC-VJPF",
    {
      reason:
        "picomatch ReDoS via repeated extglobs (high). Affects every published picomatch " +
        "(<=4.0.7, latest at 2026-11-18), so no override or upgrade clears it. Reached only " +
        "through dev tooling (typescript-eslint, @convex-dev/eslint-plugin, vite, vitest via " +
        "tinyglobby/fdir), which match glob patterns from this repository's own config, not " +
        "untrusted input. `npm audit fix --force` would downgrade vitest to 3.1.4 (breaking). " +
        "Owner-approved 2026-11-18. Remove once a fixed picomatch is published.",
      added: "2026-11-18",
      expires: "2026-12-02",
      devOnly: true,
    },
  ],
]);

const BLOCKING_SEVERITIES = new Set(["moderate", "high", "critical"]);

function advisoryId(value) {
  const match = /(?:^|\/)(GHSA-[0-9a-z-]+)(?:$|[?#])/i.exec(String(value ?? ""));
  return match ? match[1].toUpperCase() : null;
}

/** Advisory objects in an `npm audit --json` report, keyed by GHSA id. */
function advisories(report) {
  const found = new Map();
  for (const [packageName, vuln] of Object.entries(report?.vulnerabilities ?? {})) {
    const via = Array.isArray(vuln?.via) ? vuln.via : [];
    via.forEach((entry, index) => {
      // A string entry names another vulnerable package; its advisory is listed there.
      if (!entry || typeof entry !== "object") return;
      const id =
        advisoryId(entry.url) ?? advisoryId(entry.source) ?? `UNIDENTIFIED:${packageName}:${index}`;
      found.set(id, {
        id,
        title: typeof entry.title === "string" ? entry.title : "Advisory",
        // Missing severity is treated as the worst case.
        severity: typeof entry.severity === "string" ? entry.severity.toLowerCase() : "critical",
      });
    });
  }
  return found;
}

/**
 * Returns the blocking advisories, each with a `reason` of `not-allowlisted`,
 * `allowlist-expired` or `reaches-production`. `today` is `YYYY-MM-DD`.
 */
export function evaluateAudit({ full, production, today, allowlist = ALLOWLIST }) {
  const productionIds = new Set(advisories(production).keys());
  const blocking = [];
  for (const advisory of advisories(full).values()) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
    const entry = allowlist.get(advisory.id);
    if (!entry) blocking.push({ ...advisory, reason: "not-allowlisted" });
    else if (today > entry.expires) blocking.push({ ...advisory, reason: "allowlist-expired" });
    else if (entry.devOnly && productionIds.has(advisory.id))
      blocking.push({ ...advisory, reason: "reaches-production" });
  }
  return blocking;
}

function auditJson(args) {
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--json", ...args], { encoding: "utf8" });
  } catch (error) {
    // npm audit exits non-zero when it finds advisories but still prints the report.
    raw = error.stdout?.toString() ?? "";
  }
  return JSON.parse(raw);
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const blocking = evaluateAudit({
    full: auditJson([]),
    production: auditJson(["--omit=dev"]),
    today,
  });
  if (blocking.length > 0) {
    console.error("Blocking vulnerabilities (moderate or worse):");
    for (const advisory of blocking) {
      console.error(
        `  ${advisory.id} [${advisory.severity}] ${advisory.reason}: ${advisory.title}`,
      );
    }
    process.exit(1);
  }
  const tolerated = [...ALLOWLIST].map(([id, entry]) => `${id} (until ${entry.expires})`);
  console.log(
    `No blocking vulnerabilities.${tolerated.length ? ` Allowlisted: ${tolerated.join(", ")}.` : ""}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
