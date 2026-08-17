import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Approval = {
  mode?: string;
  binding?: string;
};

type ActionFamily = {
  id: string;
  approval?: Approval;
};

type ActionRegistry = {
  action_families: ActionFamily[];
};

type YamlModule = {
  load(input: string): unknown;
  dump(input: unknown, options?: { lineWidth?: number }): string;
};

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const typescriptRoot = path.resolve(here, "..");
const repoRoot = path.resolve(typescriptRoot, "..");
const registryPath = path.join(repoRoot, "docs/traceability/action-family-registry.yaml");

function runWithMutation(mutate: (registry: ActionRegistry) => void) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "jarvis-action-map-"));
  try {
    const registry = yaml.load(readFileSync(registryPath, "utf8")) as ActionRegistry;
    mutate(registry);
    const mutatedPath = path.join(tempDir, "action-family-registry.yaml");
    writeFileSync(mutatedPath, yaml.dump(registry, { lineWidth: -1 }), "utf8");

    return spawnSync(process.execPath, ["scripts/validate-action-map.mjs"], {
      cwd: typescriptRoot,
      env: {
        ...process.env,
        JARVIS_ACTION_MAP_REGISTRY_PATH: mutatedPath,
      },
      encoding: "utf8",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function requireFamily(registry: ActionRegistry, id: string): ActionFamily {
  const family = registry.action_families.find((candidate) => candidate.id === id);
  assert.ok(family, `Expected ${id} in action-family registry`);
  return family;
}

test("semantic validator rejects destructive actions without exact approval", () => {
  const result = runWithMutation((registry) => {
    const family = requireFamily(registry, "AM-007");
    family.approval = {
      ...(family.approval ?? {}),
      mode: "never",
      binding: "exact_action_fingerprint",
    };
  });

  assert.notEqual(result.status, 0, `validator unexpectedly passed:\n${result.stdout}`);
  assert.match(result.stderr, /RULE-007: AM-007/);
});

test("semantic validator rejects external side effects without exact approval", () => {
  const result = runWithMutation((registry) => {
    const family = requireFamily(registry, "AM-013");
    family.approval = {
      ...(family.approval ?? {}),
      mode: "never",
      binding: "exact_action_fingerprint",
    };
  });

  assert.notEqual(result.status, 0, `validator unexpectedly passed:\n${result.stdout}`);
  assert.match(result.stderr, /RULE-008: AM-013/);
});
