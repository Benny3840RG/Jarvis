import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JARVIS_MAIN_RULESET_NAME,
  REQUIRED_MAIN_CHECKS,
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

function successfulApi({ existingEnforcement } = {}) {
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
                name: JARVIS_MAIN_RULESET_NAME,
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
      return json({ id, ...body });
    }
    if (path === "/repos/Benny3840RG/Jarvis/rules/branches/main" && method === "GET") {
      return json(expectedBranchRules(id));
    }
    if (path === "/repos/Benny3840RG/Jarvis/branches/main" && method === "GET") {
      return json({ name: "main", protected: true });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { calls, fetchImpl, id };
}

test("policy requires every trusted candidate check, Jarvis PASS and no review or bypass", () => {
  assert.deepEqual(REQUIRED_MAIN_CHECKS, [
    "automation-policy",
    "typecheck-lint-format-test",
    "jarvis-console-01-build",
    "pr-evidence",
    "Analyze (actions)",
    "Analyze (python)",
    "Analyze (ruby)",
    "Analyze (javascript-typescript)",
    "jarvis-pr-maintenance/review",
  ]);
  const policy = desiredMainRuleset("active");
  assert.equal(policy.name, JARVIS_MAIN_RULESET_NAME);
  assert.equal(policy.enforcement, "active");
  assert.deepEqual(policy.bypass_actors, []);
  assert.deepEqual(policy.conditions, {
    ref_name: { include: ["refs/heads/main"], exclude: [] },
  });
  assert.deepEqual(
    policy.rules.map((rule) => rule.type),
    ["deletion", "non_fast_forward", "pull_request", "required_status_checks"],
  );
  const pullRequest = policy.rules.find((rule) => rule.type === "pull_request");
  assert.deepEqual(pullRequest.parameters, {
    allowed_merge_methods: ["merge", "squash", "rebase"],
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
    required_review_thread_resolution: false,
  });
  const checks = policy.rules.find((rule) => rule.type === "required_status_checks");
  assert.equal(checks.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(
    checks.parameters.required_status_checks,
    REQUIRED_MAIN_CHECKS.map((context) => ({ context, integration_id: 15368 })),
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
