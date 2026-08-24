import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const violations = trackedFiles.filter((path) => {
  if (path === "jarvis-console-01" || path.startsWith("jarvis-console-01/")) {
    return true;
  }

  if (path === "typescript/dist" || path.startsWith("typescript/dist/")) {
    return true;
  }

  if (/^typescript\/.*\/dist(?:\/|$)/.test(path)) {
    return true;
  }

  const basename = path.split("/").at(-1);
  return (
    path === ".github/pull_request_update" ||
    basename === "pr-body.md" ||
    basename === "pull_request_update"
  );
});

if (violations.length > 0) {
  console.error("Repository hygiene check failed. Forbidden tracked artefacts:");
  for (const path of violations) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log("Repository hygiene check passed.");
