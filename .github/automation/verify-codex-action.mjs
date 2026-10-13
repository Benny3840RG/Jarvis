// v1.13 includes worker-only socket ACL isolation upstream. Verify, never patch,
// the immutable action bundle before either trusted worker startup path uses it.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_ACTION_SHA = "bdf19a4a223ec2549a3e2274a0cf61556bc07675";
export const BUNDLE_HASH =
  "24b4bb0de44d67b2c2ed15f9e780f93887c5bfe688445e00d0bd5de4b380a232";

export function verifyCodexBundle(bundle) {
  if (createHash("sha256").update(bundle).digest("hex") !== BUNDLE_HASH) {
    throw new Error(
      "Pinned Codex action bundle hash mismatch; refusing worker startup.",
    );
  }
  return bundle;
}

export function verifyDownloadedCodexAction(runnerTemp) {
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error(
      "An absolute RUNNER_TEMP is required for Codex startup validation.",
    );
  }
  const bundlePath = path.join(
    path.dirname(fs.realpathSync(runnerTemp)),
    "_actions/openai/codex-action",
    CODEX_ACTION_SHA,
    "dist/main.js",
  );
  const fd = fs.openSync(
    bundlePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 16 * 1024 * 1024) {
      throw new Error("Expected a regular pinned Codex action bundle.");
    }
    verifyCodexBundle(fs.readFileSync(fd));
    const after = fs.lstatSync(bundlePath);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Codex action bundle changed during startup validation.");
    }
  } finally {
    fs.closeSync(fd);
  }
  return bundlePath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux" || process.argv.length !== 2) {
    throw new Error(
      "Usage on Linux: node verify-codex-action.mjs (requires RUNNER_TEMP)",
    );
  }
  verifyDownloadedCodexAction(process.env.RUNNER_TEMP);
  console.log(
    "Verified unmodified Codex v1.13 bundle with upstream worker-only socket isolation.",
  );
}
