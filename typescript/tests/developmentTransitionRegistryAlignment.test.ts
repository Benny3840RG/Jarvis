import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEVELOPMENT_TRANSITIONS } from "../src/development/transitionRegistry.js";

type YamlModule = { load(input: string): unknown };

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlModule;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type CanonicalTransition = {
  id: string;
  from: string | string[];
  to: string;
  side_effect_class: string;
  requested_by: string[];
  evaluated_by: string[];
  authorised_by: string[];
  committed_by: string;
  evaluator: string;
  gates: string[];
  evidence_required: string[];
  operation_retry: Record<string, unknown>;
  reconciliation?: Record<string, unknown>;
  constitutional_invariants?: string[];
};

type CanonicalTransitionContract = {
  schema_version: number;
  contract_id: string;
  transitions: CanonicalTransition[];
};

function canonicalTransitions(): CanonicalTransitionContract {
  return yaml.load(
    readFileSync(`${repoRoot}TRANSITIONS.yaml`, "utf8"),
  ) as CanonicalTransitionContract;
}

function runtimeFields(id: string): Record<string, unknown> {
  const entry = (DEVELOPMENT_TRANSITIONS as Record<string, unknown>)[id];
  assert.ok(entry, `runtime registry is missing ${id}`);
  return entry as Record<string, unknown>;
}

test("root TRANSITIONS.yaml is the sole machine-readable transition authority", () => {
  const rootTransitionFiles = readdirSync(repoRoot).filter((file) =>
    file.endsWith("TRANSITIONS.yaml"),
  );

  assert.deepEqual(rootTransitionFiles, ["TRANSITIONS.yaml"]);
  assert.equal(existsSync(`${repoRoot}JARVIS_TRANSITIONS.yaml`), false);
});

test("all 19 canonical transitions map exactly once to the runtime registry", () => {
  const contract = canonicalTransitions();
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract_id, "JARVIS_DEVELOPMENT_TRANSITIONS_V1");
  assert.equal(contract.transitions.length, 19);
  assert.equal(Object.keys(DEVELOPMENT_TRANSITIONS).length, 19);

  for (const transition of contract.transitions) {
    const runtime = runtimeFields(transition.id);
    assert.deepEqual(
      runtime.sources,
      Array.isArray(transition.from) ? transition.from : [transition.from],
      transition.id,
    );
    assert.equal(runtime.target, transition.to, transition.id);
    assert.equal(runtime.sideEffectClass, transition.side_effect_class, transition.id);
    assert.deepEqual(runtime.requestedBy, transition.requested_by, transition.id);
    assert.deepEqual(runtime.evaluatedBy, transition.evaluated_by, transition.id);
    assert.deepEqual(runtime.authorisedBy, transition.authorised_by, transition.id);
    assert.equal(runtime.committedBy, transition.committed_by, transition.id);
    assert.equal(runtime.evaluator, transition.evaluator, transition.id);
    assert.deepEqual(runtime.gates, transition.gates, transition.id);
    assert.deepEqual(runtime.evidenceRequired, transition.evidence_required, transition.id);
    assert.deepEqual(runtime.operationRetry, transition.operation_retry, transition.id);
    assert.deepEqual(runtime.reconciliation, transition.reconciliation, transition.id);
    assert.deepEqual(
      runtime.constitutionalInvariants,
      transition.constitutional_invariants ?? [],
      transition.id,
    );
  }
});

test("runtime registry has no transition absent from TRANSITIONS.yaml", () => {
  const canonicalIds = new Set(
    canonicalTransitions().transitions.map((transition) => transition.id),
  );
  for (const id of Object.keys(DEVELOPMENT_TRANSITIONS)) {
    assert.ok(canonicalIds.has(id), `runtime registry has ${id} with no canonical source`);
  }
});

test("explanatory transition documentation has one section for every canonical ID", () => {
  const markdown = readFileSync(`${repoRoot}JARVIS_TRANSITIONS.md`, "utf8");
  for (const transition of canonicalTransitions().transitions) {
    const heading = `## ${transition.id}`;
    const count = markdown.split("\n").filter((line) => line.trim() === heading).length;
    assert.equal(count, 1, `${heading} must occur exactly once`);
  }
});

test("obsolete RECONCILIATION_OPEN topology is absent and canonical indeterminate routes remain", () => {
  const contract = canonicalTransitions();
  const ids = new Set(contract.transitions.map((transition) => transition.id));
  const serialized = JSON.stringify(contract);

  assert.equal(serialized.includes("RECONCILIATION_OPEN"), false);
  assert.ok(ids.has("DEV_TRANSITION_READY_TO_MERGE_TO_INDETERMINATE"));
  assert.ok(ids.has("DEV_TRANSITION_INDETERMINATE_TO_MERGED"));
  assert.ok(ids.has("DEV_TRANSITION_INDETERMINATE_TO_READY_TO_MERGE"));
  assert.ok(ids.has("DEV_TRANSITION_INDETERMINATE_TO_CONTRADICTED"));
  assert.ok(ids.has("DEV_TRANSITION_INDETERMINATE_TO_FAILED"));
});
