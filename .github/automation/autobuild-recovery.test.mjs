import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyAutobuildRecovery,
  MAX_AUTOMATIC_RETRIES,
} from "./autobuild-recovery.mjs";

const retry = {
  action: "retry",
  reason: "transient-pre-publication-failure",
};
const invalid = { action: "block", reason: "invalid-diagnostic-receipt" };
const nonRetryable = {
  action: "block",
  reason: "non-retryable-build-failure",
};

function receipt(buildResult = "failure", stages = {}) {
  return {
    build_result: buildResult,
    verification_result: "skipped",
    stages: {
      dependencies: "success",
      worker: "failure",
      guard: "skipped",
      publication: "skipped",
      ...stages,
    },
  };
}

test("missing or malformed diagnostics cannot authorize a retry", async (t) => {
  for (const value of [undefined, null, [], "failure", 1, true, {}]) {
    await t.test(`receipt ${JSON.stringify(value)}`, () => {
      assert.deepEqual(classifyAutobuildRecovery({ receipt: value }), invalid);
    });
  }
  for (const stages of [undefined, null, [], "failure", 1, true, {}]) {
    await t.test(`stages ${JSON.stringify(stages)}`, () => {
      assert.deepEqual(
        classifyAutobuildRecovery({ receipt: { ...receipt(), stages } }),
        invalid,
      );
    });
  }
});

test("every consumed outcome must be explicitly present and recognized", async (t) => {
  for (const field of [
    "build_result",
    "verification_result",
    "dependencies",
    "worker",
    "guard",
    "publication",
  ]) {
    for (const value of [
      undefined,
      null,
      "",
      "unknown",
      "SUCCESS",
      0,
      {},
      [],
    ]) {
      await t.test(`${field}=${JSON.stringify(value)}`, () => {
        const diagnostic = receipt();
        const target = field.endsWith("_result")
          ? diagnostic
          : diagnostic.stages;
        if (value === undefined) delete target[field];
        else target[field] = value;
        assert.deepEqual(
          classifyAutobuildRecovery({ receipt: diagnostic }),
          invalid,
        );
      });
    }
  }
});

test("later executed stages require successful predecessors", async (t) => {
  const names = ["dependencies", "worker", "guard", "publication"];
  for (let index = 0; index < names.length - 1; index += 1) {
    for (const earlier of ["failure", "cancelled", "skipped", "unavailable"]) {
      for (const later of ["success", "failure", "cancelled"]) {
        await t.test(
          `${names[index]}=${earlier}, ${names[index + 1]}=${later}`,
          () => {
            const diagnostic = receipt(
              "failure",
              Object.fromEntries(
                names.map((name, position) => [
                  name,
                  position < index ? "success" : "skipped",
                ]),
              ),
            );
            diagnostic.stages[names[index]] = earlier;
            diagnostic.stages[names[index + 1]] = later;
            assert.deepEqual(
              classifyAutobuildRecovery({ receipt: diagnostic }),
              invalid,
            );
          },
        );
      }
    }
  }
});

test("a successful build cannot contain a failed, cancelled, or skipped stage", async (t) => {
  for (const outcome of ["failure", "cancelled", "skipped"]) {
    await t.test(outcome, () => {
      assert.deepEqual(
        classifyAutobuildRecovery({
          receipt: receipt("success", {
            worker: "success",
            guard: "success",
            publication: outcome,
          }),
        }),
        invalid,
      );
    });
  }
});

test("only dependency and worker stops receive bounded automatic retries", async (t) => {
  for (const buildResult of ["failure", "cancelled"]) {
    for (const outcome of ["failure", "cancelled", "unavailable"]) {
      for (const pending of ["skipped", "unavailable"]) {
        await t.test(`dependency ${buildResult}/${outcome}/${pending}`, () => {
          assert.deepEqual(
            classifyAutobuildRecovery({
              receipt: receipt(buildResult, {
                dependencies: outcome,
                worker: pending,
                guard: pending,
                publication: pending,
              }),
            }),
            retry,
          );
        });
        await t.test(`worker ${buildResult}/${outcome}/${pending}`, () => {
          assert.deepEqual(
            classifyAutobuildRecovery({
              receipt: receipt(buildResult, {
                worker: outcome,
                guard: pending,
                publication: pending,
              }),
            }),
            retry,
          );
        });
      }
    }
  }
});

test("cancelled jobs may explicitly report unavailable outputs for every stage", () => {
  assert.deepEqual(
    classifyAutobuildRecovery({
      receipt: receipt("cancelled", {
        dependencies: "unavailable",
        worker: "unavailable",
        guard: "unavailable",
        publication: "unavailable",
      }),
    }),
    retry,
  );
});

test("policy guard and publication failures remain blocked", () => {
  assert.deepEqual(
    classifyAutobuildRecovery({
      receipt: receipt("failure", { worker: "success", guard: "failure" }),
    }),
    { action: "block", reason: "policy-guard-failure" },
  );
  for (const guard of ["cancelled", "skipped", "unavailable"]) {
    assert.deepEqual(
      classifyAutobuildRecovery({
        receipt: receipt("failure", { worker: "success", guard }),
      }),
      nonRetryable,
    );
  }
  for (const publication of ["failure", "cancelled"]) {
    assert.deepEqual(
      classifyAutobuildRecovery({
        receipt: receipt("failure", {
          worker: "success",
          guard: "success",
          publication,
        }),
      }),
      nonRetryable,
    );
  }
});

test("published candidates are not retried even when verification fails", () => {
  const diagnostic = receipt("success", {
    worker: "success",
    guard: "success",
    publication: "success",
  });
  diagnostic.verification_result = "failure";
  assert.deepEqual(classifyAutobuildRecovery({ receipt: diagnostic }), {
    action: "ignore",
    reason: "candidate-published",
  });
});

test("executed verification requires a successful build and publication", () => {
  for (const verification of ["success", "failure", "cancelled"]) {
    for (const buildResult of [
      "failure",
      "cancelled",
      "skipped",
      "unavailable",
    ]) {
      const diagnostic = receipt(buildResult, {
        worker: "success",
        guard: "success",
        publication: "success",
      });
      diagnostic.verification_result = verification;
      assert.deepEqual(
        classifyAutobuildRecovery({ receipt: diagnostic }),
        invalid,
        `verification=${verification} cannot follow build=${buildResult}`,
      );
    }
    const diagnostic = receipt("success", {
      worker: "success",
      guard: "success",
      publication: "unavailable",
    });
    diagnostic.verification_result = verification;
    assert.deepEqual(
      classifyAutobuildRecovery({ receipt: diagnostic }),
      invalid,
      `verification=${verification} requires recorded publication success`,
    );
  }
});

test("unstarted jobs cannot authorize retries", () => {
  for (const buildResult of ["success", "skipped", "unavailable"]) {
    assert.deepEqual(
      classifyAutobuildRecovery({
        receipt: receipt(buildResult, {
          dependencies: "unavailable",
          worker: "unavailable",
          guard: "unavailable",
          publication: "unavailable",
        }),
      }),
      nonRetryable,
    );
  }
});

test("at most two retries are allowed and malformed budgets fail closed", () => {
  assert.equal(MAX_AUTOMATIC_RETRIES, 2);
  for (const priorRetries of [0, 1]) {
    assert.deepEqual(
      classifyAutobuildRecovery({ receipt: receipt(), priorRetries }),
      retry,
    );
  }
  for (const priorRetries of [2, 3, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(
      classifyAutobuildRecovery({ receipt: receipt(), priorRetries }),
      { action: "block", reason: "retry-budget-exhausted" },
    );
  }
  for (const priorRetries of [-1, 0.5, NaN, Infinity, "0", null]) {
    assert.deepEqual(
      classifyAutobuildRecovery({ receipt: receipt(), priorRetries }),
      { action: "block", reason: "invalid-retry-count" },
    );
  }
});

async function runRecoveryWorkflow({
  events,
  commentError,
  removeError,
  blocked = true,
  failures = [],
  newerBuild = false,
  retrySource,
  legacyRetrySource,
  historyTotal = newerBuild ? 2 : 1,
}) {
  const workflow = readFileSync(
    new URL("../workflows/jarvis-autobuild-recovery.yml", import.meta.url),
    "utf8",
  );
  const scriptBody = workflow.split("          script: |\n")[1];
  assert.ok(scriptBody?.trim(), "recovery workflow must contain github-script");
  const script = scriptBody
    .split("\n")
    .map((line) => line.slice(12))
    .join("\n");
  const diagnostic = { ...receipt(), run_id: 123 };
  const run = {
    id: 123,
    path: ".github/workflows/jarvis-autobuild.yml",
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    display_title: "Jarvis build issue #435",
    created_at: "2026-09-15T08:00:00Z",
    head_repository: { full_name: "owner/repo" },
  };
  const comment = (body) => ({ user: { login: "github-actions[bot]" }, body });
  const github = {
    paginate: async (fn) => fn(),
    rest: {
      issues: {
        get: async () => ({
          data: {
            state: "open",
            labels: [
              "automation-approved",
              ...(blocked ? ["automation-blocked"] : []),
            ],
          },
        }),
        listComments: async () => [
          comment(
            "### Build diagnostic receipt\n\n```json\n" +
              JSON.stringify(diagnostic) +
              "\n```",
          ),
          ...(newerBuild
            ? [
                comment(
                  "### Build diagnostic receipt\n\n```json\n" +
                    JSON.stringify({
                      ...receipt("failure", {
                        worker: "success",
                        guard: "failure",
                      }),
                      run_id: 124,
                    }) +
                    "\n```",
                ),
              ]
            : []),
          ...(retrySource
            ? [
                comment(
                  `<!-- jarvis-autobuild-auto-retry:v1 -->\n<!-- jarvis-autobuild-auto-retry-source:${retrySource} -->`,
                ),
              ]
            : []),
          ...(legacyRetrySource
            ? [
                comment(
                  `<!-- jarvis-autobuild-auto-retry:v1 -->\nSource run: https://github.com/owner/repo/actions/runs/${legacyRetrySource}.`,
                ),
              ]
            : []),
        ],
        createComment: async ({ body }) => {
          events.push("comment");
          assert.match(body, /<!-- jarvis-autobuild-auto-retry:v1 -->/);
          assert.match(body, /Automatic bounded retry 1\/2/);
          if (commentError) throw commentError;
        },
        removeLabel: async ({ name }) => {
          events.push("unblock");
          assert.equal(name, "automation-blocked");
          if (removeError) throw removeError;
        },
      },
      actions: {
        listWorkflowRuns: async (args) => {
          assert.equal(args.workflow_id, "jarvis-autobuild.yml");
          assert.equal(args.branch, "main");
          assert.equal(args.event, "workflow_dispatch");
          assert.equal(args.created, ">=2026-09-15T08:00:00Z");
          assert.equal(args.per_page, 100);
          return {
            data: {
              total_count: historyTotal,
              workflow_runs: [
                run,
                ...(newerBuild
                  ? [{ ...run, id: 124, created_at: "2026-09-15T08:01:00Z" }]
                  : []),
              ],
            },
          };
        },
        createWorkflowDispatch: async ({ workflow_id, ref }) => {
          events.push("dispatch");
          assert.equal(workflow_id, "jarvis-queue-advance.yml");
          assert.equal(ref, "main");
        },
      },
    },
  };
  return new Function(
    "context",
    "github",
    "core",
    "process",
    "require",
    `return (async () => {\n${script}\n})();`,
  )(
    {
      repo: { owner: "owner", repo: "repo" },
      serverUrl: "https://github.com",
      payload: {
        workflow_run: run,
      },
    },
    github,
    { info: () => {}, setFailed: (message) => failures.push(message) },
    {
      env: {
        GITHUB_WORKSPACE: fileURLToPath(new URL("../../", import.meta.url)),
      },
    },
    createRequire(import.meta.url),
  );
}

test("recovery persists its retry marker before unblocking or dispatching", async () => {
  const events = [];
  await runRecoveryWorkflow({ events });
  assert.deepEqual(events, ["comment", "unblock", "dispatch"]);
});

test("retry marker write failure leaves the mission blocked and undispatched", async () => {
  const events = [];
  const commentError = new Error("receipt storage unavailable");
  await assert.rejects(
    runRecoveryWorkflow({ events, commentError }),
    commentError,
  );
  assert.deepEqual(events, ["comment"]);
});

test("unblock failure stops dispatch after the retry budget has been recorded", async () => {
  const events = [];
  const removeError = new Error("label update unavailable");
  await assert.rejects(
    runRecoveryWorkflow({ events, removeError }),
    removeError,
  );
  assert.deepEqual(events, ["comment", "unblock"]);
});

test("an already unblocked mission still records its budget before dispatch", async () => {
  const events = [];
  await runRecoveryWorkflow({ events, blocked: false });
  assert.deepEqual(events, ["comment", "dispatch"]);
});

test("an older transient failure cannot clear a newer policy guard block", async () => {
  const events = [];
  await runRecoveryWorkflow({ events, newerBuild: true });
  assert.deepEqual(events, []);
});

test("replayed completion cannot retry a source already recorded in either marker format", async () => {
  for (const marker of [{ retrySource: 123 }, { legacyRetrySource: 123 }]) {
    const events = [];
    await runRecoveryWorkflow({ events, ...marker });
    assert.deepEqual(events, []);
  }
});

test("incomplete or over-budget workflow history cannot unblock a mission", async () => {
  for (const historyTotal of [0, 2, 101, "1"]) {
    const events = [];
    const failures = [];
    await runRecoveryWorkflow({ events, failures, historyTotal });
    assert.deepEqual(events, []);
    assert.equal(failures.length, 1);
  }
});
