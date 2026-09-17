import { pathToFileURL } from "node:url";

// Scope, deliberately narrow (see docs/operations/branch-protection.md):
//
// Classic branch protection on `main` — applied and verified separately under
// issue #398, not by this tool — already requires a pull request, an
// up-to-date branch, the five checks `pr-evidence`, `automation-policy`,
// `typecheck-lint-format-test`, `jarvis-console-01-build`, `CodeQL`, and
// blocks force pushes and branch deletion. This tool does not duplicate or
// replace any of that.
//
// This tool manages exactly one thing: a ruleset that closes the gap #563
// found — GitHub's CodeQL Default Setup can post a "configurations not
// found" result (not a failure) when `main`'s own baseline scan is stale,
// which let a PR merge with no CodeQL evidence at all for its head commit.
// The `code_scanning` rule type is the fix: a missing or in-progress result
// blocks merge by design, it isn't an extra flag to set.
//
// `jarvis-pr-maintenance/review` is intentionally NOT a required check here
// or anywhere else. It was explicitly excluded from classic protection under
// #398 because it fails closed on ambiguous/incomplete review context and
// can block a clean PR for reasons unrelated to any real defect (observed on
// PR #502, 2026-09-14, and again on PR #564, 2026-09-16, where one review
// segment simply lacked the file under test in its own context). Making it
// a hard, no-bypass gate before that failure mode is fixed would risk
// deadlocking legitimate merges. Revisit only after it's fixed and proven
// not to do that.
//
// `security_alerts_threshold`/`alerts_threshold` below are GitHub's current
// UI defaults for this rule, recorded as the baseline in effect, not a
// deliberate severity policy decision — revisit that separately if wanted.

export const MAIN_RULESET_NAME = "main required code scanning";

const EXPECTED_REPOSITORY = "Benny3840RG/Jarvis";
const API = "https://api.github.com";

export function desiredMainRuleset(enforcement = "active") {
  if (!["active", "disabled"].includes(enforcement)) {
    throw new Error("Ruleset enforcement must be active or disabled.");
  }
  return {
    name: MAIN_RULESET_NAME,
    target: "branch",
    enforcement,
    bypass_actors: [],
    conditions: {
      ref_name: { include: ["refs/heads/main"], exclude: [] },
    },
    rules: [
      {
        type: "code_scanning",
        parameters: {
          code_scanning_tools: [
            {
              tool: "CodeQL",
              security_alerts_threshold: "high_or_higher",
              alerts_threshold: "errors",
            },
          ],
        },
      },
    ],
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function policyView(value) {
  return {
    name: value?.name,
    target: value?.target,
    enforcement: value?.enforcement,
    bypass_actors: value?.bypass_actors ?? [],
    conditions: value?.conditions,
    rules: value?.rules,
  };
}

function assertPolicy(actual, expected, label) {
  if (canonical(policyView(actual)) !== canonical(expected)) {
    throw new Error(`${label} does not match the exact Jarvis policy.`);
  }
}

function safeMessage(value) {
  return typeof value === "string" && value.length <= 500
    ? value.replaceAll(/\s+/g, " ").trim()
    : "GitHub request failed";
}

function client(fetchImpl, token, repository) {
  const root = `${API}/repos/${repository}`;
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${path} failed (${response.status}): ${safeMessage(data?.message)}`,
      );
    }
    return data;
  };
}

function assertEffectiveRules(rules, rulesetId) {
  if (!Array.isArray(rules)) throw new Error("Effective branch rules are unavailable.");
  const sourceId = (rule) => {
    const direct = rule?.ruleset_id;
    const nested =
      rule?.ruleset_source && typeof rule.ruleset_source === "object"
        ? rule.ruleset_source.id
        : undefined;
    const directValid = Number.isSafeInteger(direct) && direct > 0;
    const nestedValid = Number.isSafeInteger(nested) && nested > 0;
    if (directValid && nestedValid && direct !== nested) return undefined;
    if (directValid) return direct;
    return nestedValid ? nested : undefined;
  };
  if (rules.some((rule) => sourceId(rule) !== rulesetId)) {
    throw new Error("Effective main rules do not match the Jarvis policy.");
  }
  const actual = rules.map(({ type, parameters }) =>
    parameters === undefined ? { type } : { type, parameters },
  );
  const expected = desiredMainRuleset("active").rules;
  if (canonical(actual) !== canonical(expected)) {
    throw new Error("Effective main rules do not match the Jarvis policy.");
  }
}

export async function configureMainRuleset({
  fetchImpl = fetch,
  repository,
  confirmedRepository,
  token,
}) {
  if (repository !== EXPECTED_REPOSITORY || confirmedRepository !== repository) {
    throw new Error(
      `Repository confirmation must exactly equal ${EXPECTED_REPOSITORY}.`,
    );
  }
  if (typeof token !== "string" || token.length < 1) {
    throw new Error("GITHUB_TOKEN is required for --apply.");
  }

  const request = client(fetchImpl, token, repository);
  const repo = await request("");
  if (repo?.full_name !== repository || repo?.default_branch !== "main") {
    throw new Error("GitHub repository identity or default branch changed.");
  }

  const summaries = await request("/rulesets?includes_parents=false");
  if (!Array.isArray(summaries)) throw new Error("Ruleset inventory is unavailable.");
  const existing = summaries.find((item) => item?.name === MAIN_RULESET_NAME);
  const foreignActive = summaries.find(
    (item) =>
      item?.target === "branch" &&
      item?.enforcement === "active" &&
      item?.name !== MAIN_RULESET_NAME,
  );
  if (foreignActive) {
    throw new Error(
      `Refusing to overlap active repository branch ruleset ${foreignActive.id}.`,
    );
  }

  if (existing?.enforcement === "active") {
    const detail = await request(`/rulesets/${existing.id}`);
    assertPolicy(detail, desiredMainRuleset("active"), "Existing active ruleset");
    assertEffectiveRules(await request("/rules/branches/main"), existing.id);
    const branch = await request("/branches/main");
    if (branch?.protected !== true) throw new Error("GitHub does not report main protected.");
    return { action: "unchanged", rulesetId: existing.id, verified: true };
  }

  const disabled = desiredMainRuleset("disabled");
  let ruleset;
  let action;
  if (existing) {
    ruleset = await request(`/rulesets/${existing.id}`, {
      method: "PUT",
      body: disabled,
    });
    action = "updated";
  } else {
    ruleset = await request("/rulesets", { method: "POST", body: disabled });
    action = "created";
  }
  if (!Number.isSafeInteger(ruleset?.id) || ruleset.id < 1) {
    throw new Error("GitHub did not return a valid ruleset ID.");
  }
  const rulesetId = ruleset.id;
  assertPolicy(
    await request(`/rulesets/${rulesetId}`),
    disabled,
    "Disabled preflight ruleset",
  );

  try {
    await request(`/rulesets/${rulesetId}`, {
      method: "PUT",
      body: desiredMainRuleset("active"),
    });
    assertPolicy(
      await request(`/rulesets/${rulesetId}`),
      desiredMainRuleset("active"),
      "Active ruleset readback",
    );
    assertEffectiveRules(await request("/rules/branches/main"), rulesetId);
    const branch = await request("/branches/main");
    if (branch?.protected !== true) throw new Error("GitHub does not report main protected.");
  } catch (error) {
    try {
      await request(`/rulesets/${rulesetId}`, { method: "PUT", body: disabled });
    } catch {
      throw new Error(
        `Ruleset readback failed: ${safeMessage(error.message)}; rollback failed, so manually disable ruleset ${rulesetId}.`,
      );
    }
    throw new Error(
      `Ruleset readback failed: ${safeMessage(error.message)}; ruleset disabled again.`,
    );
  }
  return { action, rulesetId, verified: true };
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return undefined;
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--apply")) {
    console.log(JSON.stringify(desiredMainRuleset("active"), null, 2));
    return;
  }
  const repository = valueAfter(args, "--repository");
  const confirmedRepository = valueAfter(args, "--confirm-repository");
  const result = await configureMainRuleset({
    repository,
    confirmedRepository,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(
    `Ruleset ${result.rulesetId} ${result.action}; active main protection verified.`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(safeMessage(error.message));
    process.exitCode = 1;
  });
}
