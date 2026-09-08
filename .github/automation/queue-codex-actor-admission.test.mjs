import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
  "utf8",
);

// Queue dispatch intentionally runs as github-actions[bot]. Keep the downstream
// Codex admission equally narrow: exact bot allowlist, never the general bypass.
const codexStep = workflow
  .split("- name: Run bounded Codex implementation")[1]
  ?.split("\n      - name:")[0] ?? "";

test("queue-dispatched Codex admits only github-actions[bot] through the bot allowlist", () => {
  assert.match(codexStep, /^\s+allow-bot-users:\s*github-actions\[bot\]\s*$/m);
  assert.doesNotMatch(codexStep, /^\s+allow-bots:\s*true\s*$/m);
  assert.doesNotMatch(codexStep, /^\s+allow-bot-users:\s*\*\s*$/m);
});
