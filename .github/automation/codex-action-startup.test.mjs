import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CODEX_ACTION_SHA } from "./verify-codex-action.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bundlePath = process.env.CODEX_ACTION_BUNDLE;
const workflows = ["jarvis-pr-maintenance.yml", "jarvis-autobuild.yml"];

test("every Codex worker workflow has a startup-path regression", () => {
  const found = fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) =>
      /uses: openai\/codex-action@/.test(read(`.github/workflows/${file}`)),
    );
  assert.deepEqual(found.sort(), [...workflows].sort());
});

function startup(source) {
  const block = source.match(
    /      - name: (?:Prepare isolated review directory and worker socket isolation|Preserve service sockets during worker isolation)\n([\s\S]*?)(?=\n      - name:)/,
  )?.[1];
  assert.ok(block, "the actual pre-worker startup step must exist");
  const lines = block.split("\n");
  const start = lines.findIndex((line) =>
    /^          node \.github\/automation\/verify-codex-action\.mjs$/.test(
      line,
    ),
  );
  assert.ok(start >= 0, "the actual bundle preparation command must exist");
  return (
    "set -euo pipefail\n" +
    lines
      .slice(start)
      .map((line) => line.slice(10))
      .join("\n")
  );
}

for (const workflow of workflows) {
  const source = read(`.github/workflows/${workflow}`);
  const actionShas = [
    ...source.matchAll(/uses: openai\/codex-action@([a-f0-9]{40})/g),
  ].map((m) => m[1]);

  test(`${workflow} uses the exact startup-validated Codex action`, () => {
    assert.deepEqual(actionShas, [CODEX_ACTION_SHA]);
    assert.match(source, /safety-strategy: drop-sudo/);
    assert.match(source, /\/usr\/bin\/setfacl/);
    assert.equal(
      (
        source.match(/node \.github\/automation\/verify-codex-action\.mjs/g) ||
        []
      ).length,
      1,
    );
    assert.doesNotMatch(
      source,
      /patch-codex-sockets|86365089eb2b84e0a8fb0717b304f8bdcb13b20e/,
    );
  });

  test(
    `${workflow} executes its actual bundle preparation without changing upstream bytes`,
    {
      skip:
        !bundlePath &&
        "Set CODEX_ACTION_BUNDLE; Linux CI supplies the pinned bundle",
    },
    (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "jarvis-codex-startup-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const runnerTemp = path.join(directory, "_temp");
      fs.mkdirSync(runnerTemp);
      const destination = path.join(
        directory,
        "_actions/openai/codex-action",
        actionShas[0],
        "dist/main.js",
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const original = fs.readFileSync(bundlePath);
      fs.writeFileSync(destination, original);
      const run = () =>
        spawnSync("bash", ["-c", startup(source)], {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: runnerTemp },
          encoding: "utf8",
          timeout: 10000,
        });
      const result = run();
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(fs.readFileSync(destination), original);
      assert.equal(
        run().status,
        0,
        "validation must be repeatable without patching the bundle",
      );

      fs.appendFileSync(destination, "\n");
      const altered = run();
      assert.notEqual(altered.status, 0);
      assert.match(altered.stderr, /bundle hash mismatch/);
      fs.rmSync(destination);
      const missing = run();
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /ENOENT|unavailable/);
      const stale = destination.replace(
        actionShas[0],
        "86365089eb2b84e0a8fb0717b304f8bdcb13b20e",
      );
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, original);
      assert.notEqual(
        run().status,
        0,
        "an old-only action directory must not satisfy startup",
      );
      const target = path.join(directory, "upstream.js");
      fs.writeFileSync(target, original);
      fs.symlinkSync(target, destination);
      const symlink = run();
      assert.notEqual(symlink.status, 0);
      assert.match(symlink.stderr, /ELOOP|symbolic|regular/);
      assert.deepEqual(fs.readFileSync(target), original);
    },
  );
}

test("Linux socket CI checks out and tests the same action as both workers", () => {
  const source = read(".github/workflows/typescript.yml");
  const fixtureSha = source.match(
    /repository: openai\/codex-action\n\s+ref: ([a-f0-9]{40})/,
  )?.[1];
  assert.equal(fixtureSha, CODEX_ACTION_SHA);
  for (const workflow of workflows) {
    assert.match(
      read(`.github/workflows/${workflow}`),
      new RegExp(`uses: openai/codex-action@${fixtureSha}`),
    );
  }
  assert.match(source, /codex-action-startup\.test\.mjs/);
  assert.match(source, /sudo .*test-codex-sockets\.mjs/);
});
