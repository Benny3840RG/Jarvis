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
    basename === "pull_request_update" ||
    isRuntimeDataPath(path)
  );
});

if (violations.length > 0) {
  console.error("Repository hygiene check failed. Forbidden tracked artefacts:");
  for (const path of violations) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

// Documents the JSON stores write under typescript/data/, plus the sidecars
// atomicJsonFile.ts and jsonFileLock.ts actually create. No .bak or -wal writer
// exists. Tracked fixtures outside this directory must stay unignored.
const mustIgnore = [
  "typescript/data/jarvis-state.json",
  "typescript/data/jarvis-builds.json",
  "typescript/data/jarvis-build-logs.json",
  "typescript/data/jarvis-upgrades.json",
  "typescript/data/jarvis-assets.json",
  "typescript/data/jarvis-preferences.json",
  "typescript/data/jarvis-clients.json",
  "typescript/data/jarvis-properties.json",
  "typescript/data/jarvis-projects.json",
  "typescript/data/jarvis-quotes.json",
  "typescript/data/jarvis-invoices.json",
  "typescript/data/jarvis-enquiries.json",
  "typescript/data/jarvis-errands.json",
  "typescript/data/jarvis-business-settings.json",
  "typescript/data/jarvis-operator-audit.jsonl",
  "typescript/data/jarvis-clients.json.lock",
  "typescript/data/jarvis-clients.json.lock.tmp-1-token",
  "typescript/data/jarvis-clients.json.lock.reclaim-abc-0",
  "typescript/data/jarvis-clients.json.lock.reclaim-abc-0.tmp-1-token",
  "typescript/data/jarvis-clients.json.corrupt-1-uuid",
  "typescript/data/.jarvis-clients.json.tmp-1-uuid",
];

const mustKeep = [
  "docs/validators/jarvis-action-map.schema.json",
  "typescript/src/quoting/fixtures/quote176.ts",
  "typescript/src/quoting/fixtures/pavingChelseaHeights.ts",
  "typescript/tests/fixtures/jsonWriter.ts",
];

const ignored = gitCheckIgnore([...mustIgnore, ...mustKeep]);
const notIgnored = mustIgnore.filter((path) => !ignored.has(path));
const overIgnored = mustKeep.filter((path) => ignored.has(path));

if (notIgnored.length > 0 || overIgnored.length > 0) {
  console.error("Repository hygiene check failed. Runtime data ignore rules:");
  for (const path of notIgnored) {
    console.error(`- not ignored: ${path}`);
  }
  for (const path of overIgnored) {
    console.error(`- ignored fixture: ${path}`);
  }
  process.exit(1);
}

console.log("Repository hygiene check passed.");

function isRuntimeDataPath(path) {
  return (
    /^typescript\/data\/jarvis-.*\.(?:json(?:[.-].*)?|jsonl)$/.test(path) ||
    /^typescript\/data\/\.jarvis-.*\.json\.tmp-/.test(path)
  );
}

function gitCheckIgnore(paths) {
  let output = "";
  try {
    output = execFileSync("git", ["check-ignore", "-z", "--no-index", "--stdin"], {
      cwd: repoRoot,
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      output = "";
    } else {
      throw error;
    }
  }
  return new Set(output.split("\0").filter(Boolean));
}
