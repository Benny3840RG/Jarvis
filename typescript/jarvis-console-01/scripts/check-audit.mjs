import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Console audit gate with a narrow, documented allowlist.
 *
 * `npm audit --audit-level=moderate` is the right default, but it fails on
 * transitive advisories that are both inapplicable to this console's usage and
 * impossible to resolve from here (no installable fixed version). Rather than
 * weaken the gate to `--audit-level=critical` (which would hide *every* high
 * advisory), this fails on any moderate-or-worse advisory that is not in the
 * allowlist below. Each entry must state why it is safe to tolerate and when it
 * can be removed. Keep this list as short as possible.
 */
const ALLOWLIST = new Map([
  [
    "GHSA-QWWW-VCR4-C8H2",
    "React Router RSC-mode CSRF bypass. Console 01 is a client-rendered mcp-use " +
      "widget and never runs React Router in RSC / server-action mode, so the " +
      "affected request path is unreachable here. The fix is react-router 8.3.0, " +
      "but react-router-dom has no 8.x line (unified into react-router in v7) and " +
      "mcp-use pins the 7.x line transitively, so it cannot be overridden. Remove " +
      "this entry once mcp-use ships a react-router >= 8.3.0 dependency.",
  ],
  [
    "GHSA-X5FP-WJ9C-MXMX",
    "qs array-limit bypass via bracket-key comma parsing (low-severity DoS-class, " +
      "CVSS 3.7). qs is a transitive dependency of mcp-use's own Express layer " +
      "(mcp-use@1.34.5 -> express@5.2.1 -> qs), not code this project depends on " +
      "directly. `npm audit fix` (unforced) resolves qs only by pulling in an " +
      "unrelated ~140-package churn across this project's esbuild/vite toolchain " +
      "-- disproportionate, unvalidated risk for a low-severity transitive advisory. " +
      "Remove this entry once mcp-use ships a qs >= 6.16.0 dependency.",
  ],
  [
    "GHSA-4MJR-XMP4-GH2G",
    "qs: Denial of Service via attacker-controlled isBuffer (moderate, CVSS 5.3). " +
      "Same transitive dependency (mcp-use -> express -> qs) and same reasoning as " +
      "GHSA-X5FP-WJ9C-MXMX above -- no fixed qs is resolvable here without the same " +
      "unrelated toolchain churn. Remove this entry once mcp-use ships a qs >= " +
      "6.16.0 dependency.",
  ],
]);

const BLOCKING_SEVERITIES = new Set(["moderate", "high", "critical"]);

function advisoryId(value) {
  const match = /(?:^|\/)(GHSA-[0-9a-z-]+)(?:$|[?#])/i.exec(String(value ?? ""));
  return match ? match[1].toUpperCase() : null;
}

function advisoryFrom(value, packageName, fallbackIndex) {
  if (typeof value === "string") {
    const id = advisoryId(value);
    return id ? { id, title: "Advisory", severity: "moderate" } : null;
  }
  if (!value || typeof value !== "object") return null;
  const id = advisoryId(value.url) ?? advisoryId(value.id) ?? advisoryId(value.source);
  const fallbackId = id ?? `UNIDENTIFIED:${packageName ?? "unknown"}:${fallbackIndex}`;
  return {
    id: fallbackId,
    title: typeof value.title === "string" ? value.title : "Advisory",
    severity: typeof value.severity === "string" ? value.severity.toLowerCase() : "critical",
  };
}

export function findBlockingAdvisories(report) {
  const found = new Map();
  for (const [packageName, vuln] of Object.entries(report?.vulnerabilities ?? {})) {
    const viaEntries = Array.isArray(vuln?.via) ? vuln.via.entries() : [];
    for (const [index, via] of viaEntries) {
      const advisory = advisoryFrom(via, packageName, index);
      if (advisory) found.set(advisory.id, advisory);
    }
  }
  for (const [index, advisory] of Object.entries(report?.advisories ?? {})) {
    const normalized = advisoryFrom(advisory, advisory?.module_name, index);
    if (normalized) found.set(normalized.id, normalized);
  }
  return [...found.values()].filter(
    (advisory) => !ALLOWLIST.has(advisory.id) && BLOCKING_SEVERITIES.has(advisory.severity),
  );
}

function main() {
  let raw;
  try {
    raw = execSync("npm audit --json", { encoding: "utf8" });
  } catch (error) {
    // `npm audit` exits non-zero when vulnerabilities exist but still prints the
    // JSON report to stdout; recover it rather than treating the exit as fatal.
    raw = error.stdout?.toString() ?? "";
  }

  const report = JSON.parse(raw);
  const blocking = findBlockingAdvisories(report);

  if (blocking.length > 0) {
    console.error("Blocking vulnerabilities (moderate+ and not in the documented allowlist):");
    for (const advisory of blocking) {
      console.error(`  ${advisory.id} [${advisory.severity}] ${advisory.title}`);
    }
    process.exit(1);
  }

  console.log("No blocking vulnerabilities.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
