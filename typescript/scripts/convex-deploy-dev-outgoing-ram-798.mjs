#!/usr/bin/env node
// Fixed development target. A receipt proves preflight, never owner approval.
import { readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(homedir(), ".local/state/jarvis-convex");
const KEY_FILE = join(STATE_DIR, "dev-outgoing-ram-798.env");
const RECEIPT_FILE = join(STATE_DIR, "last-dry-run-receipt.json");
const EXPECTED_KEY_PREFIX = "dev:outgoing-ram-798|";
const EXPECTED_URL = "https://outgoing-ram-798.convex.cloud";
const RECEIPT_TTL_MS = 20 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}
function invalidateReceipt() {
  try {
    unlinkSync(RECEIPT_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail("Credential/receipt path must be owned, private and not a symlink.");
}
function loadDeployKey() {
  privatePath(STATE_DIR, true);
  privatePath(KEY_FILE);
  const lines = readFileSync(KEY_FILE, "utf8").trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith("CONVEX_DEPLOY_KEY="))
    fail("Expected one deployment-key binding.");
  const key = lines[0].slice("CONVEX_DEPLOY_KEY=".length).trim();
  if (
    !key.startsWith(EXPECTED_KEY_PREFIX) ||
    key.length <= EXPECTED_KEY_PREFIX.length ||
    /\s/.test(key)
  )
    fail("Expected the scoped outgoing-ram-798 development deploy key.");
  return key;
}
function requireCleanWorkingTree(expected) {
  if (execFileSync("git", ["status", "--short"], { cwd: REPO_DIR }).toString().trim())
    fail("Working tree must be clean.");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR }).toString().trim();
  if (!SHA.test(sha) || (expected && sha !== expected))
    fail("Candidate changed; repeat preflight and owner review.");
  return sha;
}
function runConvex(dryRun, key) {
  // Exclude application secrets, NODE_OPTIONS and inherited Convex overrides.
  const env = { CONVEX_DEPLOY_KEY: key, NO_COLOR: "1" };
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const args = [
    "node_modules/convex/bin/main.js",
    "deploy",
    "--verbose",
    "--env-file",
    KEY_FILE,
    "--codegen",
    "disable",
    "--typecheck",
    "enable",
    "--skip-workos-check",
  ];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  // Never relay raw provider errors or verbose startPush details.
  if (result.error || result.status !== 0)
    fail(`Convex ${dryRun ? "preflight" : "deployment"} failed; no automatic retry.`);
  const output = (String(result.stdout || "") + "\n" + String(result.stderr || ""))
    .split(key)
    .join("[REDACTED]");
  if (!output.includes(EXPECTED_URL)) fail("Expected development target was not confirmed.");
  // CLI 1.45 can print an empty runtime heading for null versus undefined.
  // Only real +/- version entries constitute a change; the finish diff below
  // independently checks the UDF runtime and all function/index changes.
  if (/^\s*\[[+-]\]\s*\S/m.test(output))
    fail("Runtime configuration changes require separate preparation.");
  const matches = [...output.matchAll(/^\{\r?\n[\s\S]*?^\}/gm)]
    .map((match) => {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    })
    .filter((value) => value && Object.hasOwn(value, "componentDiffs"));
  if (matches.length !== 1) fail("Exactly one structured Convex finish diff is required.");
  const starts = [...output.matchAll(/^startPush: (\{\r?\n[\s\S]*?^\})/gm)].map((match) => {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  });
  if (starts.length !== 1 || !starts[0]?.schemaChange)
    fail("Exactly one structured Convex start response is required.");
  const preflightIndexDiffs = starts[0].schemaChange.indexDiffs ?? {};
  if (
    !preflightIndexDiffs ||
    typeof preflightIndexDiffs !== "object" ||
    Array.isArray(preflightIndexDiffs) ||
    Object.keys(preflightIndexDiffs).some((key) => key !== "")
  )
    fail("Unsupported start-phase component index evidence.");
  for (const indexes of Object.values(preflightIndexDiffs)) validateIndexes(indexes);
  return { ...validatePlan(matches[0]), preflightIndexDiffs };
}
function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail(`Unsupported ${label} evidence.`);
}
function array(value, label) {
  if (!Array.isArray(value)) fail(`Invalid ${label} evidence.`);
  return value;
}
function validatePlan(plan) {
  object(plan, ["authDiff", "definitionDiffs", "componentDiffs"], "finish diff");
  object(plan.authDiff, ["added", "removed"], "auth diff");
  if (array(plan.authDiff.added, "auth").length || array(plan.authDiff.removed, "auth").length)
    fail("Auth changes require separate preparation.");
  object(plan.definitionDiffs, [], "component definitions");
  if (
    !plan.componentDiffs ||
    typeof plan.componentDiffs !== "object" ||
    Array.isArray(plan.componentDiffs) ||
    Object.keys(plan.componentDiffs).some((key) => key !== "")
  )
    fail("Component changes require separate preparation.");
  const root = plan.componentDiffs[""];
  if (root) {
    object(
      root,
      ["diffType", "moduleDiff", "udfConfigDiff", "cronDiff", "indexDiff", "schemaDiff"],
      "component diff",
    );
    object(root.diffType, ["type"], "component operation");
    if (root.diffType.type !== "modify") fail("Component lifecycle changes are refused.");
    object(root.moduleDiff, ["added", "removed"], "module diff");
    if (array(root.moduleDiff.removed, "removed modules").length)
      fail("Module deletion is refused.");
    if (array(root.moduleDiff.added, "added modules").some((name) => typeof name !== "string"))
      fail("Invalid module names.");
    object(root.cronDiff, ["added", "updated", "deleted"], "cron diff");
    if (Object.values(root.cronDiff).some((items) => array(items, "cron").length))
      fail("Cron changes require separate preparation.");
    validateIndexes(root.indexDiff);
    if (root.schemaDiff !== null || root.udfConfigDiff !== null)
      fail("Schema/runtime changes require separate preparation.");
  }
  return plan;
}
function validateIndexes(indexes) {
  object(
    indexes,
    [
      "added_indexes",
      "removed_indexes",
      ...["enabled_indexes", "disabled_indexes"].filter((key) => Object.hasOwn(indexes || {}, key)),
    ],
    "index diff",
  );
  if (
    array(indexes.removed_indexes, "removed indexes").length ||
    array(indexes.disabled_indexes || [], "disabled indexes").length
  )
    fail("Index removal or disabling is refused.");
  for (const index of [
    ...array(indexes.added_indexes, "added indexes"),
    ...array(indexes.enabled_indexes || [], "enabled indexes"),
  ]) {
    if (!index || !["database", "search", "vector"].includes(index.type))
      fail("Invalid index evidence.");
    const fields =
      index.type === "database"
        ? ["fields"]
        : index.type === "search"
          ? ["searchField", "filterFields"]
          : ["dimensions", "vectorField", "filterFields"];
    object(
      index,
      ["name", "type", ...fields, ...(Object.hasOwn(index, "staged") ? ["staged"] : [])],
      "index definition",
    );
    if (
      typeof index.name !== "string" ||
      !index.name ||
      (Object.hasOwn(index, "staged") && typeof index.staged !== "boolean")
    )
      fail("Invalid index definition.");
    for (const key of ["fields", "filterFields"].filter((key) => Object.hasOwn(index, key))) {
      if (array(index[key], "index fields").some((field) => typeof field !== "string" || !field))
        fail("Invalid index fields.");
    }
    for (const key of ["searchField", "vectorField"].filter((key) => Object.hasOwn(index, key))) {
      if (typeof index[key] !== "string" || !index[key]) fail("Invalid index field.");
    }
    if (
      index.type === "vector" &&
      (!Number.isSafeInteger(index.dimensions) || index.dimensions <= 0)
    )
      fail("Invalid vector dimensions.");
  }
}
function pendingIndexes(indexes) {
  return indexes.added_indexes.length > 0 || (indexes.enabled_indexes || []).length > 0;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function fingerprint(plan) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(plan)))
    .digest("hex");
}
function validateReceipt(receipt, sha) {
  const age = Date.now() - receipt?.createdAtMs;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.sha !== sha ||
    receipt.target !== EXPECTED_URL ||
    !HASH.test(receipt.planHash || "") ||
    !Number.isSafeInteger(receipt.createdAtMs) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > RECEIPT_TTL_MS
  )
    fail("Invalid, stale or differently bound preflight receipt; repeat dry run and owner review.");
}
function dryRun() {
  invalidateReceipt(); // Invalidate even if git, credentials or provider preflight fails.
  const sha = requireCleanWorkingTree();
  const plan = runConvex(true, loadDeployKey());
  requireCleanWorkingTree(sha);
  writeFileSync(
    RECEIPT_FILE,
    JSON.stringify({
      version: 1,
      sha,
      createdAtMs: Date.now(),
      target: EXPECTED_URL,
      planHash: fingerprint(plan),
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(plan, null, 2));
  console.log(`Preflight recorded for ${sha}. Explicit owner approval is still required.`);
}
function realDeploy() {
  if (!existsSync(RECEIPT_FILE))
    fail("No preflight receipt; run --dry-run and obtain owner approval.");
  privatePath(STATE_DIR, true);
  privatePath(RECEIPT_FILE);
  const raw = readFileSync(RECEIPT_FILE, "utf8");
  invalidateReceipt(); // Consume on all subsequent failures, including malformed JSON.
  const receipt = JSON.parse(raw);
  const sha = requireCleanWorkingTree();
  validateReceipt(receipt, sha);
  const key = loadDeployKey();
  const currentPlan = runConvex(true, key);
  if (fingerprint(currentPlan) !== receipt.planHash)
    fail("Deployment plan changed since approved preflight.");
  requireCleanWorkingTree(sha);
  validateReceipt(receipt, sha);
  runConvex(false, key);
  requireCleanWorkingTree(sha);
  console.log("Development deployment command succeeded; run --verify for no-change readback.");
}
function verify() {
  const sha = requireCleanWorkingTree();
  const plan = runConvex(true, loadDeployKey());
  requireCleanWorkingTree(sha);
  if (Object.values(plan.preflightIndexDiffs).some(pendingIndexes))
    fail("Verification found unapplied start-phase index changes.");
  const root = plan.componentDiffs[""];
  if (
    root &&
    (root.moduleDiff.added.length ||
      root.indexDiff.added_indexes.length ||
      (root.indexDiff.enabled_indexes || []).length)
  )
    fail("Verification found unapplied function/index changes.");
  console.log(
    `Verified no pending backend changes for ${sha} at ${EXPECTED_URL}. No receipt written.`,
  );
}
try {
  if (process.argv.length !== 3) fail("Usage: --dry-run | --deploy | --verify");
  const mode = process.argv[2];
  if (mode === "--dry-run") dryRun();
  else if (mode === "--deploy") realDeploy();
  else if (mode === "--verify") verify();
  else fail("Usage: --dry-run | --deploy | --verify");
} catch (error) {
  console.error(
    `REFUSED: ${error instanceof SyntaxError ? "Malformed preflight receipt." : error.message}`,
  );
  process.exitCode = 1;
}
