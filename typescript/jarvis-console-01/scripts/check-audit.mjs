import { execSync } from "node:child_process";

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
    "GHSA-qwww-vcr4-c8h2",
    "React Router RSC-mode CSRF bypass. Console 01 is a client-rendered mcp-use " +
      "widget and never runs React Router in RSC / server-action mode, so the " +
      "affected request path is unreachable here. The fix is react-router 8.3.0, " +
      "but react-router-dom has no 8.x line (unified into react-router in v7) and " +
      "mcp-use pins the 7.x line transitively, so it cannot be overridden. Remove " +
      "this entry once mcp-use ships a react-router >= 8.3.0 dependency.",
  ],
]);

const BLOCKING_SEVERITIES = new Set(["moderate", "high", "critical"]);

function advisoryId(url) {
  const match = /\/(GHSA-[0-9a-z-]+)$/i.exec(url ?? "");
  return match ? match[1] : null;
}

let raw;
try {
  raw = execSync("npm audit --json", { encoding: "utf8" });
} catch (error) {
  // `npm audit` exits non-zero when vulnerabilities exist but still prints the
  // JSON report to stdout; recover it rather than treating the exit as fatal.
  raw = error.stdout?.toString() ?? "";
}

const report = JSON.parse(raw);
const found = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (via && typeof via === "object") {
      const id = advisoryId(via.url);
      if (id) found.set(id, { title: via.title, severity: via.severity });
    }
  }
}

const blocking = [...found].filter(
  ([id, info]) => !ALLOWLIST.has(id) && BLOCKING_SEVERITIES.has(info.severity),
);

if (blocking.length > 0) {
  console.error("Blocking vulnerabilities (moderate+ and not in the documented allowlist):");
  for (const [id, info] of blocking) {
    console.error(`  ${id} [${info.severity}] ${info.title}`);
  }
  process.exit(1);
}

const tolerated = [...found].filter(([id]) => ALLOWLIST.has(id));
for (const [id] of tolerated) {
  console.log(`Tolerating documented advisory ${id}: ${ALLOWLIST.get(id)}`);
}
console.log("No blocking vulnerabilities.");
