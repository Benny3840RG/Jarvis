import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("runtime source has explicit control-plane ownership", () => {
  const entries = read(".github/CODEOWNERS")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const uncovered = readdirSync(new URL("typescript/src/", root), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(root.pathname.length),
    )
    .filter((file) => {
      const owners = entries
        .filter(([pattern]) => {
          const relative = pattern.replace(/^\//, "");
          return relative.endsWith("/")
            ? file.startsWith(relative)
            : matchesGlob(file, relative);
        })
        .at(-1)
        ?.slice(1);
      return !owners?.includes("@Benny3840");
    });
  assert.deepEqual(
    uncovered,
    [],
    "runtime source must retain explicit owner review coverage",
  );
});

test("both governance triggers cover canonical registries and validator runtime inputs", () => {
  const rules = read("docs/validators/jarvis-action-map.rules.yaml");
  const references = [...rules.matchAll(/^  \w+: (docs\/[^\s]+)$/gm)].map(
    (m) => m[1],
  );
  assert.ok(
    references.length >= 6,
    "canonical reference registries must be discovered",
  );
  const workflow = read(".github/workflows/governance-validation.yml");
  const inputs = [
    ...references,
    "typescript/package.json",
    "typescript/package-lock.json",
    "typescript/.nvmrc",
  ];
  const blocks = [
    workflow.match(/\n  pull_request:\n([\s\S]*?)\n  push:/)?.[1],
    workflow.match(/\n  push:\n([\s\S]*?)\npermissions:/)?.[1],
  ];
  for (const block of blocks) {
    assert.ok(block, "both events must retain their governance path filters");
    const patterns = [...block.matchAll(/^\s+- "([^"\n]+)"$/gm)].map(
      (m) => m[1],
    );
    for (const reference of inputs) {
      assert.ok(
        patterns.some((pattern) => matchesGlob(reference, pattern)),
        `${reference} does not trigger governance validation`,
      );
    }
  }
});
