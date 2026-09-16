#!/usr/bin/env node
// Hardened Convex deployment mechanism for dev:outgoing-ram-798 ONLY.
//
// Replaces the personal-access-token -> authorize_within_current_project -> bare
// admin-key flow with a dedicated, deployment-scoped Convex deploy key.
//
// Usage (from typescript/):
//   node scripts/convex-deploy-dev-outgoing-ram-798.mjs --dry-run
//   node scripts/convex-deploy-dev-outgoing-ram-798.mjs --deploy
//   node scripts/convex-deploy-dev-outgoing-ram-798.mjs --verify
//
// See docs/operations/convex-dev-deploy-key.md for the full mechanism.
//
// Safety properties (see docs/operations/dual-agent-coordination.md and
// JARVIS_CONSTITUTION.md JARVIS-003, JARVIS-017 for the governing rules this
// implements):
//   - Never reads ~/.convex/config.json or any personal access token.
//   - Never accepts or derives a bare/admin key; only a prefixed deploy key
//     (`dev:outgoing-ram-798|...`) loaded from an out-of-repo, 0600 file.
//   - The key is never interpolated into a logged string, an argv, or a file
//     this script writes; it exists only as a value in the child process's
//     environment object.
//   - Hardcoded target: no flags can redirect this script at a different
//     deployment, and any "prod"/"production" key prefix is refused outright.
//   - `--deploy` requires a clean git working tree AND a fresh, matching
//     dry-run receipt (single-use, git-SHA-bound, 20 minute TTL) produced by
//     `--dry-run` immediately before. There is no way to reach a real deploy
//     without that receipt.
//   - Output is scanned for destructive/deletion signals and for the literal
//     key value before anything is written to stdout or a log file.
//
// This script intentionally has ONE valid target. Do not generalize it to
// accept an arbitrary deployment argument -- copy it and change the
// constants below for a new mission instead, so "prod" can never be reached
// by a flag-parsing mistake.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(SCRIPT_DIR); // typescript/scripts/.. -> typescript/
const KEY_FILE = join(homedir(), '.local/state/jarvis-convex/dev-outgoing-ram-798.env');
const RECEIPT_FILE = join(homedir(), '.local/state/jarvis-convex/last-dry-run-receipt.json');
const EXPECTED_KEY_PREFIX = 'dev:outgoing-ram-798|';
const EXPECTED_URL = 'https://outgoing-ram-798.convex.cloud';
const RECEIPT_TTL_MS = 20 * 60 * 1000;

const DANGER_PATTERNS = [
  /Deleted table indexes/i,
  /Would delete/i,
  /removed_indexes/i,
  /schema.*breaking/i,
  /data loss/i,
  /destructive/i,
];

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function redact(text, secret) {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

function loadDeployKey() {
  if (!existsSync(KEY_FILE)) {
    fail(`deploy key file not found at ${KEY_FILE}. Provision it with 'convex deployment token create' and --save-env; never paste the key into chat.`);
  }
  const raw = readFileSync(KEY_FILE, 'utf8');
  const match = raw.split('\n').find((line) => line.startsWith('CONVEX_DEPLOY_KEY='));
  if (!match) fail('CONVEX_DEPLOY_KEY line not found in key file.');
  const key = match.slice('CONVEX_DEPLOY_KEY='.length).trim();
  if (!key) fail('CONVEX_DEPLOY_KEY value is empty.');
  if (key.toLowerCase().includes('prod')) {
    fail('deploy key prefix mentions prod/production; refusing.');
  }
  if (!key.startsWith(EXPECTED_KEY_PREFIX)) {
    fail(`deploy key does not start with the expected prefix ${EXPECTED_KEY_PREFIX}; refusing before any network call.`);
  }
  return key;
}

function requireCleanWorkingTree() {
  const status = execFileSync('git', ['status', '--short'], { cwd: REPO_DIR }).toString();
  if (status.trim().length > 0) {
    fail('working tree is not clean; commit, stash, or discard changes before deploying.');
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim();
}

function runConvex(args, deployKey) {
  const env = { ...process.env };
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_URL;
  env.CONVEX_DEPLOY_KEY = deployKey; // only place the secret is ever assigned
  const result = spawnSync(
    process.execPath,
    ['node_modules/convex/bin/main.js', 'deploy', ...args],
    { cwd: REPO_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout = redact((result.stdout || Buffer.alloc(0)).toString(), deployKey);
  const stderr = redact((result.stderr || Buffer.alloc(0)).toString(), deployKey);
  return { status: result.status, stdout, stderr };
}

function assertNoDangerAndCorrectTarget(combined) {
  const hits = DANGER_PATTERNS.filter((p) => p.test(combined));
  if (hits.length > 0) {
    fail(`output matched destructive/unexpected pattern(s): ${hits.map((h) => h.toString()).join(', ')}`);
  }
  if (!combined.includes(EXPECTED_URL)) {
    fail(`deployment output did not reference the expected URL ${EXPECTED_URL}; refusing to trust this run.`);
  }
}

function dryRun() {
  const sha = requireCleanWorkingTree();
  const deployKey = loadDeployKey();
  const { status, stdout, stderr } = runConvex(
    ['--dry-run', '--codegen', 'disable', '--typecheck', 'enable', '--skip-workos-check'],
    deployKey,
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const combined = stdout + stderr;
  if (status !== 0) fail(`dry-run exited ${status}; not writing an approval receipt.`);
  assertNoDangerAndCorrectTarget(combined);
  writeFileSync(
    RECEIPT_FILE,
    JSON.stringify({ sha, createdAtMs: Date.now(), target: EXPECTED_URL }),
    { mode: 0o600 },
  );
  console.log(`\nDry-run clean. Receipt written for commit ${sha}.`);
  console.log('A real deploy now requires explicit approval and must be run within 20 minutes, from this exact commit, via --deploy.');
}

function realDeploy() {
  const sha = requireCleanWorkingTree();
  if (!existsSync(RECEIPT_FILE)) {
    fail('no dry-run receipt found. Run --dry-run first and get explicit approval before --deploy.');
  }
  const receipt = JSON.parse(readFileSync(RECEIPT_FILE, 'utf8'));
  unlinkSync(RECEIPT_FILE); // single-use, whether or not the checks below pass
  if (receipt.sha !== sha) {
    fail('dry-run receipt was for a different commit than the current working tree; re-run --dry-run.');
  }
  if (Date.now() - receipt.createdAtMs > RECEIPT_TTL_MS) {
    fail('dry-run receipt expired (20 minute TTL); re-run --dry-run.');
  }
  const deployKey = loadDeployKey();
  const { status, stdout, stderr } = runConvex(
    ['--codegen', 'disable', '--typecheck', 'enable', '--skip-workos-check'],
    deployKey,
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const combined = stdout + stderr;
  assertNoDangerAndCorrectTarget(combined);
  if (status !== 0) fail(`deploy exited ${status}.`);
  console.log('\nReal deploy complete.');
}

function verify() {
  // Non-mutating post-deploy check: reuses --dry-run's diff. If the target
  // state already matches local code, Convex reports an empty/no-op diff
  // (e.g. no "Would add" for an index that has already landed).
  requireCleanWorkingTree();
  const deployKey = loadDeployKey();
  const { status, stdout, stderr } = runConvex(
    ['--dry-run', '--codegen', 'disable', '--typecheck', 'enable', '--skip-workos-check'],
    deployKey,
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const combined = stdout + stderr;
  if (status !== 0) fail(`verification dry-run exited ${status}.`);
  assertNoDangerAndCorrectTarget(combined);
  console.log('\nVerification dry-run clean (non-mutating; no receipt written).');
}

const mode = process.argv[2];
if (mode === '--dry-run') dryRun();
else if (mode === '--deploy') realDeploy();
else if (mode === '--verify') verify();
else fail('usage: --dry-run | --deploy | --verify');
