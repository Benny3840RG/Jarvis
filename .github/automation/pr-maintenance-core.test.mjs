import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectCandidateChecks,
  collectReviewContext,
  parseReview,
  maintenanceDisposition,
} from "./pr-maintenance.mjs";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const names = [
  "automation-policy",
  "typecheck-lint-format-test",
  "jarvis-console-01-build",
  "pr-evidence",
  ...["actions", "python", "ruby", "javascript-typescript"].map(
    (language) => `Analyze (${language})`,
  ),
];
function evidence() {
  return names.map((name, index) => ({
    id: index + 1,
    name,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    details_url: `https://github.com/owner/repo/actions/runs/${index + 1}`,
  }));
}
function githubFor(items) {
  return {
    rest: {
      checks: {
        listForRef: async ({ page }) => ({
          data: {
            total_count: items.length,
            check_runs: items.slice((page - 1) * 100, page * 100),
          },
        }),
      },
      actions: {
        getWorkflowRun: async ({ run_id: id }) => ({
          data: {
            id,
            head_sha: headSha,
            event: "pull_request",
            path:
              names[id - 1] === "pr-evidence"
                ? ".github/workflows/copilot-check.yml"
                : names[id - 1]?.startsWith("Analyze")
                  ? "dynamic/github-code-scanning/codeql"
                  : ".github/workflows/typescript.yml",
          },
        }),
      },
    },
  };
}

test("complete check snapshots have order-independent fingerprint and changed evidence changes it", async () => {
  const items = evidence();
  const collect = (items) =>
    collectCandidateChecks({
      github: githubFor(items),
      owner: "owner",
      repo: "repo",
      headSha,
    });
  const a = await collect(items);
  const b = await collect([...items].reverse());
  assert.equal(a.ci.ok, true);
  assert.equal(a.fingerprint, b.fingerprint);
  const c = await collect(
    items.map((x, i) => (i === 0 ? { ...x, conclusion: "failure" } : x)),
  );
  assert.equal(c.ci.ok, false);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("check collection paginates completely and refuses duplicate, truncated, changing totals and foreign URLs", async () => {
  const items = [
    ...evidence(),
    ...Array.from({ length: 100 }, (_, i) => ({
      id: i + 20,
      name: `extra-${i}`,
    })),
  ];
  assert.equal(
    (
      await collectCandidateChecks({
        github: githubFor(items),
        owner: "owner",
        repo: "repo",
        headSha,
      })
    ).checkRuns.length,
    108,
  );
  for (const mode of ["duplicate", "empty", "changed", "foreign"]) {
    const github = githubFor(items);
    if (mode === "foreign")
      items[0] = {
        ...items[0],
        details_url: "https://github.com/attacker/repo/actions/runs/1",
      };
    else
      github.rest.checks.listForRef = async ({ page }) => ({
        data: {
          total_count: mode === "changed" && page === 2 ? 107 : 108,
          check_runs:
            page === 1
              ? items.slice(0, 100)
              : mode === "duplicate"
                ? items.slice(0, 8)
                : mode === "empty"
                  ? []
                  : items.slice(100),
        },
      });
    await assert.rejects(
      collectCandidateChecks({ github, owner: "owner", repo: "repo", headSha }),
    );
  }
});

test("review schema cannot request repair without a concrete finding or sneak in shell arguments", () => {
  const record = {
    verdict: "changes_requested",
    summary: "One concrete correctness issue.",
    findings: [
      {
        file: "src/a.ts",
        line: 2,
        severity: "high",
        message: "The branch ignores a rejected result.",
      },
    ],
  };
  assert.deepEqual(parseReview(JSON.stringify(record)), record);
  assert.throws(() => parseReview(JSON.stringify({ ...record, findings: [] })));
  assert.throws(() =>
    parseReview(
      JSON.stringify({
        ...record,
        findings: [{ ...record.findings[0], command: "sh" }],
      }),
    ),
  );
  assert.throws(() =>
    parseReview(
      JSON.stringify({
        ...record,
        findings: [{ ...record.findings[0], file: "../secret" }],
      }),
    ),
  );
  assert.equal(
    maintenanceDisposition({
      ci: { ok: true, problems: [], pending: [] },
      review: record,
      repairEligible: true,
      repairCount: 1,
    }),
    "repair",
  );
  assert.equal(
    maintenanceDisposition({
      ci: { ok: false, problems: ["untrusted producer"], pending: [] },
      review: record,
      repairEligible: true,
      repairCount: 0,
    }),
    "blocked",
  );
});

test("review snapshots use old rename path and exact base/head; do not fetch absent sides", async () => {
  const calls = [];
  const github = {
    rest: {
      repos: {
        getContent: async (args) => {
          calls.push(args);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: "YQ==",
              size: 1,
            },
          };
        },
      },
    },
  };
  const result = await collectReviewContext({
    github,
    owner: "owner",
    repo: "repo",
    headSha,
    baseSha,
    changedFiles: 3,
    files: [
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
      { filename: "added.ts", status: "added" },
      { filename: "removed.ts", status: "removed" },
    ],
  });
  assert.deepEqual(
    calls.map((x) => [x.path, x.ref]),
    [
      ["old.ts", baseSha],
      ["new.ts", headSha],
      ["added.ts", headSha],
      ["removed.ts", baseSha],
    ],
  );
  assert.equal(result[1].before, null);
  assert.equal(result[2].after, null);
});

test("binary, invalid UTF8, noncanonical/truncated bytes and over-budget context fail closed", async () => {
  for (const mode of ["binary", "utf8", "size", "encoding", "budget"]) {
    const bytes =
      mode === "binary"
        ? Buffer.from([0])
        : mode === "utf8"
          ? Buffer.from([255])
          : mode === "budget"
            ? Buffer.alloc(100 * 1024, 97)
            : Buffer.from("a");
    const github = {
      rest: {
        repos: {
          getContent: async () => ({
            data: {
              type: "file",
              encoding: "base64",
              size: mode === "size" ? 20 : bytes.length,
              content:
                mode === "encoding" ? "not-base64" : bytes.toString("base64"),
            },
          }),
        },
      },
    };
    await assert.rejects(
      collectReviewContext({
        github,
        owner: "owner",
        repo: "repo",
        headSha,
        baseSha,
        changedFiles: 1,
        files: [{ filename: "a.ts", status: "modified" }],
      }),
    );
  }
});
