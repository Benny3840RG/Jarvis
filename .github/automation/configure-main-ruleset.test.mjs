import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAIN_RULESET_NAME,
  configureMainRuleset,
  desiredMainRuleset,
} from "./configure-main-ruleset.mjs";

const repository = "Benny3840RG/Jarvis";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function expectedBranchRules(id) {
  return desiredMainRuleset("active").rules.map((rule) => ({
    ...rule,
    ruleset_id: id,
  }));
}

function successfulApi({
  existingEnforcement,
  additionalEffectiveRules = [],
  failActivationResponse = false,
  useNestedRulesetSource = false,
  conflictingRulesetSource = false,
} = {}) {
  const calls = [];
  let enforcement = existingEnforcement ?? "disabled";
  const id = 9001;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({
      path,
      method,
      body,
      authorization: options.headers?.authorization,
      apiVersion: options.headers?.["x-github-api-version"],
    });
    if (path === "/repos/Benny3840RG/Jarvis" && method === "GET") {
      return json({ full_name: repository, default_branch: "main" });
    }
    if (
      path === "/repos/Benny3840RG/Jarvis/rulesets?includes_parents=false" &&
      method === "GET"
    ) {
      return json([
        { id: 18831602, name: "JaRvIs7", target: "branch", enforcement: "disabled" },
        { id: 19147000, name: "main", target: "branch", enforcement: "disabled" },
        ...(existingEnforcement
          ? [
              {
                id,
                name: MAIN_RULESET_NAME,
                target: "branch",
                enforcement: existingEnforcement,
              },
            ]
          : []),
      ]);
    }
    if (path === "/repos/Benny3840RG/Jarvis/rulesets" && method === "POST") {
      assert.deepEqual(body, desiredMainRuleset("disabled"));
      return json({ id, ...body }, 201);
    }
    if (path === `/repos/Benny3840RG/Jarvis/rulesets/${id}` && method === "GET") {
      return json({ id, ...desiredMainRuleset(enforcement) });
    }
    if (path === `/repos/Benny3840RG/Jarvis/rulesets/${id}` && method === "PUT") {
      enforcement = body.enforcement;
      if (body.enforcement === "active" && failActivationResponse) {
        throw new Error("connection lost after activation request");
      }
      return json({ id, ...body });
    }
    if (path === "/repos/Benny3840RG/Jarvis/rules/branches/main" && method === "GET") {
      const ownRules = expectedBranchRules(id).map((rule) =>
        useNestedRulesetSource
          ? { ...rule, ruleset_id: undefined, ruleset_source: { id } }
          : conflictingRulesetSource
            ? { ...rule, ruleset_source: { id: id + 1 } }
          : rule,
      );
      return json([...ownRules, ...additionalEffectiveRules]);
    }
    if (path === "/repos/Benny3840RG/Jarvis/branches/main" && method === "GET") {
      return json({ name: "main", protected: true });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { calls, fetchImpl, id };
}

test("policy is exactly the narrow CodeQL code-scanning gate, no review or bypass", () => {
  const policy = desiredMainRuleset("active");
  assert.equal(policy.name, MAIN_RULESET_NAME);
  assert.equal(policy.enforcement, "active");
  assert.deepEqual(policy.bypass_actors, []);
  assert.deepEqual(policy.conditions, {
    ref_name: { include: ["refs/heads/main"], exclude: [] },
  });
  assert.deepEqual(
    policy.rules.map((rule) => rule.type),
    ["code_scanning"],
  );
  const codeScanning = policy.rules.find((rule) => rule.type === "code_scanning");
  assert.deepEqual(codeScanning.parameters, {
    code_scanning_tools: [
      {
        tool: "CodeQL",
        security_alerts_threshold: "high_or_higher",
        alerts_threshold: "errors",
      },
    ],
  });
  // This ruleset must never grow a pull_request/required_status_checks/
  // deletion/non_fast_forward rule: those are classic branch protection's
  // job (applied separately, see docs/operations/branch-protection.md), and
  // jarvis-pr-maintenance/review must never appear here (see file header).
  assert.equal(
    policy.rules.some((rule) => rule.type !== "code_scanning"),
    false,
  );
});

test("apply stages disabled policy, activates it, and verifies effective main rules", async () => {
  const fixture = successfulApi();
  const result = await configureMainRuleset({
    fetchImpl: fixture.fetchImpl,
    repository,
    confirmedRepository: repository,
    token: "secret-value",
  });
  assert.deepEqual(result, { action: "created", rulesetId: fixture.id, verified: true });
  assert.equal(fixture.calls[2].method, "POST");
  assert.equal(fixture.calls[2].body.enforcement, "disabled");
  assert.equal(fixture.calls[4].method, "PUT");
  assert.equal(fixture.calls[4].body.enforcement, "active");
  assert.ok(fixture.calls.every((call) => call.authorization === "Bearer secret-value"));
  assert.ok(fixture.calls.every((call) => call.apiVersion === "2022-11-28"));
});

test("apply verifies an existing active policy without writing", async () => {
  const fixture = successfulApi({ existingEnforcement: "active" });
  const result = await configureMainRuleset({
    fetchImpl: fixture.fetchImpl,
    repository,
    confirmedRepository: repository,
    token: "secret-value",
  });
  assert.deepEqual(result, { action: "unchanged", rulesetId: fixture.id, verified: true });
  assert.equal(
    fixture.calls.some((call) => ["POST", "PUT"].includes(call.method)),
    false,
  );
});

test("apply repairs its existing disabled policy before activation", async () => {
  const fixture = successfulApi({ existingEnforcement: "disabled" });
  const result = await configureMainRuleset({
    fetchImpl: fixture.fetchImpl,
    repository,
    confirmedRepository: repository,
    token: "secret-value",
  });
  assert.deepEqual(result, { action: "updated", rulesetId: fixture.id, verified: true });
  assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
  const updates = fixture.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(
    updates.map((call) => call.body.enforcement),
    ["disabled", "active"],
  );
});

test("apply refuses a different active repository ruleset before creating anything", async () => {
  let wrote = false;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (options.method === "POST" || options.method === "PUT") wrote = true;
    if (path === "/repos/Benny3840RG/Jarvis") {
      return json({ full_name: repository, default_branch: "main" });
    }
    if (path.endsWith("/rulesets?includes_parents=false")) {
      return json([{ id: 12, name: "other", target: "branch", enforcement: "active" }]);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "secret-value",
      }),
    /active repository branch ruleset/i,
  );
  assert.equal(wrote, false);
});

test("failed effective readback disables the newly activated ruleset", async () => {
  const fixture = successfulApi();
  const original = fixture.fetchImpl;
  fixture.fetchImpl = async (url, options = {}) => {
    if (new URL(url).pathname.endsWith("/rules/branches/main")) return json([]);
    return original(url, options);
  };
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "secret-value",
      }),
    /readback failed.*disabled again/i,
  );
  const updates = fixture.calls.filter((call) => call.method === "PUT");
  assert.equal(updates.at(-1).body.enforcement, "disabled");
});

test("apply rejects additional effective rules from another ruleset", async () => {
  const fixture = successfulApi({
    additionalEffectiveRules: [{ type: "deletion", ruleset_id: 8128 }],
  });
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "secret-value",
      }),
    /effective main rules do not match/i,
  );
  const updates = fixture.calls.filter((call) => call.method === "PUT");
  assert.equal(updates.at(-1).body.enforcement, "disabled");
});

test("apply accepts the alternate nested effective-rule source identifier", async () => {
  const fixture = successfulApi({ useNestedRulesetSource: true });
  const result = await configureMainRuleset({
    fetchImpl: fixture.fetchImpl,
    repository,
    confirmedRepository: repository,
    token: "secret-value",
  });
  assert.deepEqual(result, { action: "created", rulesetId: fixture.id, verified: true });
});

test("apply rejects conflicting direct and nested effective-rule identifiers", async () => {
  const fixture = successfulApi({ conflictingRulesetSource: true });
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "secret-value",
      }),
    /effective main rules do not match/i,
  );
  const updates = fixture.calls.filter((call) => call.method === "PUT");
  assert.equal(updates.at(-1).body.enforcement, "disabled");
});

test("an uncertain activation response still rolls the ruleset back to disabled", async () => {
  const fixture = successfulApi({ failActivationResponse: true });
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "secret-value",
      }),
    /readback failed.*disabled again/i,
  );
  const updates = fixture.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(
    updates.map((call) => call.body.enforcement),
    ["active", "disabled"],
  );
});

test("apply requires the exact repository confirmation and a token", async () => {
  const fixture = successfulApi();
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: "somewhere/else",
        token: "secret-value",
      }),
    /confirmation/i,
  );
  await assert.rejects(
    () =>
      configureMainRuleset({
        fetchImpl: fixture.fetchImpl,
        repository,
        confirmedRepository: repository,
        token: "",
      }),
    /GITHUB_TOKEN/i,
  );
  assert.equal(fixture.calls.length, 0);
});
