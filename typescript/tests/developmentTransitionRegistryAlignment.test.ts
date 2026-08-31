import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEVELOPMENT_TRANSITIONS } from "../src/development/transitionRegistry.js";

type YamlModule = {
  load(input: string): unknown;
};

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlModule;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type YamlTransition = {
  id: string;
  domain: string;
  from: string;
  to: string;
  side_effect_class: string;
  authoritative_committer: string;
  evaluator: string;
  approval: string;
  reversible: boolean;
  retry_target: string;
  invariants: string[];
  gates?: string[];
  indeterminate_resolution?: {
    opens_state: string;
    permitted_resolvers: string[];
    terminal_by_timeout: boolean;
    resolution_requires_external_observation: boolean;
  };
};

type YamlRegistry = {
  version: number;
  schema_version: number;
  transitions: YamlTransition[];
};

function loadYamlRegistry(): YamlRegistry {
  const raw = readFileSync(`${repoRoot}JARVIS_TRANSITIONS.yaml`, "utf8");
  return yaml.load(raw) as YamlRegistry;
}

test("every YAML transition ID has exactly one TypeScript registry entry with matching fields", () => {
  const registry = loadYamlRegistry();

  assert.equal(registry.transitions.length, Object.keys(DEVELOPMENT_TRANSITIONS).length);

  for (const yamlTransition of registry.transitions) {
    const tsTransition = (
      DEVELOPMENT_TRANSITIONS as Record<
        string,
        (typeof DEVELOPMENT_TRANSITIONS)[keyof typeof DEVELOPMENT_TRANSITIONS]
      >
    )[yamlTransition.id];
    assert.ok(tsTransition, `missing TypeScript registry entry for ${yamlTransition.id}`);

    assert.equal(tsTransition.domain, yamlTransition.domain, yamlTransition.id);
    assert.equal(tsTransition.from, yamlTransition.from, yamlTransition.id);
    assert.equal(tsTransition.to, yamlTransition.to, yamlTransition.id);
    assert.equal(tsTransition.sideEffectClass, yamlTransition.side_effect_class, yamlTransition.id);
    assert.equal(
      tsTransition.authoritativeCommitter,
      yamlTransition.authoritative_committer,
      yamlTransition.id,
    );
    assert.equal(tsTransition.evaluator, yamlTransition.evaluator, yamlTransition.id);
    assert.equal(tsTransition.approval, yamlTransition.approval, yamlTransition.id);
    assert.equal(tsTransition.reversible, yamlTransition.reversible, yamlTransition.id);
    assert.equal(tsTransition.retryTarget, yamlTransition.retry_target, yamlTransition.id);
    assert.deepEqual([...tsTransition.invariants], yamlTransition.invariants, yamlTransition.id);
    assert.deepEqual(
      tsTransition.gates ? [...tsTransition.gates] : undefined,
      yamlTransition.gates,
      yamlTransition.id,
    );

    if (yamlTransition.indeterminate_resolution) {
      assert.ok(tsTransition.indeterminateResolution, yamlTransition.id);
      assert.equal(
        tsTransition.indeterminateResolution?.opensState,
        yamlTransition.indeterminate_resolution.opens_state,
        yamlTransition.id,
      );
      assert.deepEqual(
        tsTransition.indeterminateResolution
          ? [...tsTransition.indeterminateResolution.permittedResolvers]
          : undefined,
        yamlTransition.indeterminate_resolution.permitted_resolvers,
        yamlTransition.id,
      );
      assert.equal(
        tsTransition.indeterminateResolution?.terminalByTimeout,
        yamlTransition.indeterminate_resolution.terminal_by_timeout,
        yamlTransition.id,
      );
      assert.equal(
        tsTransition.indeterminateResolution?.resolutionRequiresExternalObservation,
        yamlTransition.indeterminate_resolution.resolution_requires_external_observation,
        yamlTransition.id,
      );
    } else {
      assert.equal(tsTransition.indeterminateResolution, undefined, yamlTransition.id);
    }
  }
});

test("no TypeScript registry entry exists without a corresponding YAML transition", () => {
  const registry = loadYamlRegistry();
  const yamlIds = new Set(registry.transitions.map((transition) => transition.id));

  for (const id of Object.keys(DEVELOPMENT_TRANSITIONS)) {
    assert.ok(yamlIds.has(id), `TypeScript registry has ${id} with no YAML source entry`);
  }
});

test("JARVIS_TRANSITIONS.md documents every YAML transition ID exactly once as a section heading", () => {
  const registry = loadYamlRegistry();
  const markdown = readFileSync(`${repoRoot}JARVIS_TRANSITIONS.md`, "utf8");

  for (const yamlTransition of registry.transitions) {
    const heading = `## ${yamlTransition.id}`;
    const occurrences = markdown.split("\n").filter((line) => line.trim() === heading).length;
    assert.equal(
      occurrences,
      1,
      `expected exactly one "${heading}" heading in JARVIS_TRANSITIONS.md, found ${occurrences}`,
    );
  }
});

test("MERGED -> COMPLETE is the sole Omega-committed transition in the registry", () => {
  const omegaCommitted = Object.values(DEVELOPMENT_TRANSITIONS).filter(
    (transition) => transition.authoritativeCommitter === "omega",
  );

  assert.equal(omegaCommitted.length, 1);
  assert.equal(omegaCommitted[0]?.id, "DEV_TRANSITION_MERGED_TO_COMPLETE");
  assert.equal(omegaCommitted[0]?.from, "MERGED");
  assert.equal(omegaCommitted[0]?.to, "COMPLETE");
  assert.equal(omegaCommitted[0]?.approval, "omega_only");
});

test("retry targets never blindly alias an authoritative transition ID (retry governs operations, not history)", () => {
  // JARVIS-016 / handover "Retry/resume": retry re-attempts the underlying
  // operation, never the authoritative state transition itself. A
  // retry_target equal to a transition ID (or literally "transition")
  // would conflate the two.
  const transitionIds = new Set(Object.keys(DEVELOPMENT_TRANSITIONS));

  for (const transition of Object.values(DEVELOPMENT_TRANSITIONS)) {
    assert.ok(
      !transitionIds.has(transition.retryTarget),
      `${transition.id}'s retryTarget "${transition.retryTarget}" aliases a transition ID`,
    );
    assert.ok(
      transition.retryTarget === "none" || transition.retryTarget.endsWith("_operation"),
      `${transition.id}'s retryTarget "${transition.retryTarget}" is neither "none" nor an "*_operation" name`,
    );
  }
});
