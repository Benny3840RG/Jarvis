#!/usr/bin/env node
// Validates docs/traceability/action-family-registry.yaml against
// docs/validators/jarvis-action-map.schema.json (structural shape) and
// docs/validators/jarvis-action-map.rules.yaml (semantic rules), in that
// order, before scripts/generate-action-map.rb is allowed to run. See
// execution_order in jarvis-action-map.rules.yaml.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Ajv from "ajv";
import yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const REGISTRY_PATH =
  process.env.JARVIS_ACTION_MAP_REGISTRY_PATH ??
  path.join(repoRoot, "docs/traceability/action-family-registry.yaml");
const SCHEMA_PATH = path.join(repoRoot, "docs/validators/jarvis-action-map.schema.json");
const RULES_PATH = path.join(repoRoot, "docs/validators/jarvis-action-map.rules.yaml");

function loadYaml(filePath) {
  return yaml.load(readFileSync(filePath, "utf8"));
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function fail(messages) {
  console.error(messages.map((message) => `  - ${message}`).join("\n"));
  process.exitCode = 1;
}

function stripSchemaKeyword(schema) {
  // ajv 6 (the version already vendored in node_modules) only understands
  // draft-07 meta-schema URIs; the $schema field here is 2020-12 for editor
  // tooling only and uses no 2020-12-only keywords, so it's safe to drop
  // before compiling.
  const { $schema, ...rest } = schema;
  return rest;
}

// --- Stage 1: JSON Schema (structural) validation ---------------------------

const registry = loadYaml(REGISTRY_PATH);
const schema = loadJson(SCHEMA_PATH);

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(stripSchemaKeyword(schema));
const schemaValid = validateSchema(registry);

if (!schemaValid) {
  console.error(`Schema validation failed for ${REGISTRY_PATH}:`);
  fail(validateSchema.errors.map((error) => `${error.instancePath || "/"} ${error.message}`));
  process.exit(1);
}
console.log("Stage 1/3: JSON Schema validation passed.");

// --- Stage 2: registry-reference validation ---------------------------------

const rules = loadYaml(RULES_PATH);
const referenceErrors = [];

function resolveReferencePath(relativePath) {
  return path.join(repoRoot, relativePath);
}

const overlaysRegistry = loadYaml(resolveReferencePath(rules.reference_registries.overlays));
const toolsRegistry = loadYaml(resolveReferencePath(rules.reference_registries.tools));
const stateTargetsRegistry = loadYaml(
  resolveReferencePath(rules.reference_registries.state_targets),
);
const requirementsRegistry = loadYaml(
  resolveReferencePath(rules.reference_registries.requirements),
);
const testsRegistry = loadYaml(resolveReferencePath(rules.reference_registries.tests));
const evidenceRegistry = loadYaml(resolveReferencePath(rules.reference_registries.evidence));

const knownOverlayNames = new Set(overlaysRegistry.overlays.map((entry) => entry.name));
const toolsById = new Map(toolsRegistry.tools.map((entry) => [entry.id, entry]));
const stateTargetsById = new Map(
  stateTargetsRegistry.state_targets.map((entry) => [entry.id, entry]),
);
const knownTestIds = new Set(
  testsRegistry.tests.map((entry) => (typeof entry === "string" ? entry : entry.id)),
);
const knownEvidenceIds = new Set(
  evidenceRegistry.evidence.map((entry) => (typeof entry === "string" ? entry : entry.id)),
);

const requirementIdPattern = /^R-[0-9]{3}[A-Z]?$/;
function requirementIdExists(id) {
  if (!requirementIdPattern.test(id)) return false;
  const [start, end] = [
    requirementsRegistry.namespace?.frozen_start ?? "R-001",
    requirementsRegistry.namespace?.frozen_end ?? "R-150",
  ].map((value) => Number.parseInt(value.slice(2, 5), 10));
  const number = Number.parseInt(id.slice(2, 5), 10);
  return number >= start && number <= end;
}

for (const family of registry.action_families) {
  if (!knownOverlayNames.has(family.policy_overlay)) {
    referenceErrors.push(
      `${family.id}: policy_overlay "${family.policy_overlay}" not found in overlays registry`,
    );
  }

  const executorId = family.bindings?.executor_id;
  const tool = toolsById.get(executorId);
  if (!tool) {
    referenceErrors.push(`${family.id}: executor_id "${executorId}" not found in tool registry`);
  } else if (family.lifecycle_status === "active" && tool.implemented !== true) {
    referenceErrors.push(
      `${family.id}: lifecycle_status is active but bound tool "${executorId}" is not marked implemented`,
    );
  }

  const stateTargetId = family.bindings?.state_target_id;
  const stateTarget = stateTargetsById.get(stateTargetId);
  if (!stateTarget) {
    referenceErrors.push(
      `${family.id}: state_target_id "${stateTargetId}" not found in state target registry`,
    );
  } else if (family.lifecycle_status === "active" && stateTarget.implemented !== true) {
    referenceErrors.push(
      `${family.id}: lifecycle_status is active but bound state target "${stateTargetId}" is not marked implemented`,
    );
  }

  const primary = family.traceability?.requirements?.primary ?? [];
  const supporting = family.traceability?.requirements?.supporting ?? [];
  if (primary.length === 0) {
    referenceErrors.push(`${family.id}: must cite at least one primary requirement`);
  }
  if (primary.length > 5) {
    referenceErrors.push(`${family.id}: cites more than 5 primary requirements`);
  }
  for (const requirementId of [...primary, ...supporting]) {
    if (!requirementIdExists(requirementId)) {
      referenceErrors.push(
        `${family.id}: requirement "${requirementId}" does not exist in the frozen namespace`,
      );
    }
  }

  for (const testId of family.traceability?.test_ids ?? []) {
    if (!knownTestIds.has(testId)) {
      referenceErrors.push(`${family.id}: test_id "${testId}" not found in test-id registry`);
    }
  }
  for (const evidenceId of family.traceability?.evidence_ids ?? []) {
    if (!knownEvidenceIds.has(evidenceId)) {
      referenceErrors.push(
        `${family.id}: evidence_id "${evidenceId}" not found in evidence-id registry`,
      );
    }
  }
}

const familyIds = new Set(registry.action_families.map((family) => family.id));
for (const workflow of registry.workflows ?? []) {
  for (const step of workflow.steps ?? []) {
    if (!familyIds.has(step.action_family)) {
      referenceErrors.push(
        `${workflow.id}: references unknown action family "${step.action_family}"`,
      );
    }
  }
}

if (referenceErrors.length > 0) {
  console.error(`Registry-reference validation failed for ${REGISTRY_PATH}:`);
  fail(referenceErrors);
  process.exit(1);
}
console.log("Stage 2/3: registry-reference validation passed.");

// --- Stage 3: semantic rule validation --------------------------------------

const semanticErrors = [];
const overlaysByName = registry.policy_overlays;

function overlayFor(family) {
  return overlaysByName[family.policy_overlay] ?? {};
}

function resolvedEffectClass(family) {
  return family.effect_class ?? overlayFor(family).effect_class;
}

function resolvedApprovalMode(family) {
  return family.approval?.mode ?? overlayFor(family).approval?.mode;
}

function resolvedApprovalBinding(family) {
  return family.approval?.binding ?? overlayFor(family).approval?.binding;
}

function resolvedExternalSideEffect(family) {
  return (
    family.execution?.external_side_effects?.mode ?? overlayFor(family).external_side_effects?.mode
  );
}

function resolvedReconciliationRequired(family) {
  return family.reconciliation?.required ?? overlayFor(family).reconciliation?.required ?? false;
}

// RULE-001
for (const family of registry.action_families) {
  if (!family.policy_overlay) {
    semanticErrors.push(`RULE-001: ${family.id} is missing a policy overlay`);
  }
}

// RULE-002
for (const family of registry.action_families) {
  if (resolvedExternalSideEffect(family) === true) {
    const reconciles =
      family.policy_overlay === "send_with_approval" ||
      resolvedReconciliationRequired(family) === true;
    if (!reconciles) {
      semanticErrors.push(
        `RULE-002: ${family.id} has external side effects but no reconciliation policy`,
      );
    }
  }
}

// RULE-003
for (const family of registry.action_families) {
  const approvalMode = resolvedApprovalMode(family);
  if (approvalMode === "always" || approvalMode === "conditional") {
    if (family.idempotency?.enabled !== true || !family.idempotency?.key_strategy) {
      semanticErrors.push(
        `RULE-003: ${family.id} requires approval but has no idempotency/key_strategy`,
      );
    }
  }
}

// RULE-004 requirement bounds already enforced in stage 2; nothing further here.

// RULE-005: an active workflow may not depend on a non-active family.
for (const workflow of registry.workflows ?? []) {
  if (workflow.lifecycle_status !== "active") continue;
  for (const step of workflow.steps ?? []) {
    const family = registry.action_families.find(
      (candidate) => candidate.id === step.action_family,
    );
    if (family && family.lifecycle_status !== "active") {
      semanticErrors.push(
        `RULE-005: active workflow ${workflow.id} depends on non-active family ${family.id}`,
      );
    }
  }
}

// RULE-006: a family cannot be active while its bindings are unimplemented.
for (const family of registry.action_families) {
  if (family.lifecycle_status !== "active") continue;
  const tool = toolsById.get(family.bindings?.executor_id);
  const stateTarget = stateTargetsById.get(family.bindings?.state_target_id);
  if (tool?.implemented !== true || stateTarget?.implemented !== true) {
    semanticErrors.push(
      `RULE-006: ${family.id} is lifecycle_status active but its tool/state-target binding is not implemented`,
    );
  }
}

// RULE-007: high-consequence action families must use exact-action approval.
const exactApprovalEffectClasses = new Set(["send", "execute", "destructive"]);
for (const family of registry.action_families) {
  const effectClass = resolvedEffectClass(family);
  if (!exactApprovalEffectClasses.has(effectClass)) continue;

  if (
    resolvedApprovalMode(family) !== "always" ||
    resolvedApprovalBinding(family) !== "exact_action_fingerprint"
  ) {
    semanticErrors.push(
      `RULE-007: ${family.id} effect_class ${effectClass} must require always/exact_action_fingerprint approval`,
    );
  }
}

// RULE-008: any concrete external side effect requires exact approval plus reconciliation.
for (const family of registry.action_families) {
  if (resolvedExternalSideEffect(family) !== true) continue;

  if (
    resolvedApprovalMode(family) !== "always" ||
    resolvedApprovalBinding(family) !== "exact_action_fingerprint" ||
    resolvedReconciliationRequired(family) !== true
  ) {
    semanticErrors.push(
      `RULE-008: ${family.id} external side effects require always/exact_action_fingerprint approval and reconciliation`,
    );
  }
}

if (semanticErrors.length > 0) {
  console.error(`Semantic rule validation failed for ${REGISTRY_PATH}:`);
  fail(semanticErrors);
  process.exit(1);
}
console.log("Stage 3/3: semantic rule validation passed.");
console.log("All validations passed. Safe to run scripts/generate-action-map.rb.");
