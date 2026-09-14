import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflow = fs.readFileSync(
  new URL("../workflows/jarvis-pr-maintenance.yml", import.meta.url),
  "utf8",
);
const reviewJob = workflow.split("\n  review:")[1].split("\n  publish:")[0];
const publishJob = workflow.split("\n  publish:")[1];

test("run names containing issue hashes are folded YAML scalars, not comments", () => {
  for (const path of ["jarvis-pr-maintenance.yml", "jarvis-autobuild.yml"]) {
    const source = fs.readFileSync(
      new URL(`../workflows/${path}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /^run-name: >-\n  \$\{\{[^\n]+#.+\}\}$/m);
  }
});

test("reviewer never receives a write token or executes a candidate checkout", () => {
  assert.match(reviewJob, /permission-profile: ":read-only"/);
  assert.match(reviewJob, /safety-strategy: drop-sudo/);
  assert.doesNotMatch(reviewJob, /:\s*write\b/);
  assert.doesNotMatch(
    reviewJob,
    /ref:.*(?:expected_head|head\.sha|pull_request)/,
  );
  assert.doesNotMatch(
    reviewJob,
    /npm (?:ci|test|run)|GH_TOKEN|JARVIS_SERVICE_TOKEN/,
  );
  assert.match(reviewJob, /working-directory:.*runner.temp/);
  // The pinned action already appends this single-use CLI flag.
  assert.doesNotMatch(reviewJob, /skip-git-repo-check/);
});

test("publication is isolated from model execution and rechecks provider evidence", () => {
  assert.match(publishJob, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(
    publishJob,
    /codex-action|contents: write|JARVIS_APPROVAL_TOKEN|OPENAI_API_KEY/,
  );
  assert.deepEqual(
    [...publishJob.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ["JARVIS_SERVICE_TOKEN"],
  );
  assert.match(publishJob, /publishSegmentedReview/);
  assert.match(publishJob, /github.workflow_sha/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|pulls\.merge|createReview|markPullRequestReady|enablePullRequestAutoMerge/,
  );
});

test("every action is SHA pinned and every checkout drops credentials", () => {
  for (const match of workflow.matchAll(/^\s*uses: (\S+)/gm))
    assert.match(match[1], /@[a-f0-9]{40}$/);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)].length;
  assert.equal(
    [...workflow.matchAll(/persist-credentials: false/g)].length,
    checkouts,
  );
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
});

test("review segments have bounded concurrency and exact manifest artifact bindings", () => {
  assert.match(reviewJob, /prompt-file:/);
  assert.match(reviewJob, /max-parallel: 2/);
  assert.match(reviewJob, /fail-fast: false/);
  assert.match(reviewJob, /rebuildSegmentedReview/);
  assert.match(reviewJob, /MANIFEST_DIGEST:/);
  assert.match(reviewJob, /upload-artifact@[a-f0-9]{40}/);
  assert.match(publishJob, /download-artifact@[a-f0-9]{40}/);
  assert.match(publishJob, /publishSegmentedReview/);
  assert.match(publishJob, /github.run_attempt/);
  assert.doesNotMatch(reviewJob, /prompt:|needs.prepare.outputs.prompt[ }]/);
});

// Exercise the publication script itself against the pinned action's two layouts.
function readDownloadedReceipts(root, segments = [0]) {
  const script = publishJob
    .slice(publishJob.indexOf("            const fs = require('node:fs');"))
    .split("            let manifest = null;")[0];
  return new Function(
    "require",
    "context",
    "process",
    `${script}\nreturn receipts;`,
  )(
    () => fs,
    { runId: 123 },
    {
      env: {
        RUNNER_TEMP: root,
        RUN_ATTEMPT: "1",
        REVIEW_MANIFEST: JSON.stringify({
          segments: segments.map((index) => ({ index })),
        }),
      },
    },
  );
}

function artifactFixture(t) {
  const root = fs.mkdtempSync("/tmp/jarvis-artifact-test-");
  fs.mkdirSync(`${root}/jarvis-review-results`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, results: `${root}/jarvis-review-results` };
}

const validReceipt = {
  index: 0,
  manifestDigest: "a".repeat(64),
  promptDigest: "b".repeat(64),
  raw: '{"verdict":"pass","summary":"fixture","findings":[],"contextRequests":[]}',
};

test("publication reads a flat single artifact produced by the pinned downloader", (t) => {
  const { root, results } = artifactFixture(t);
  fs.writeFileSync(`${results}/result.json`, JSON.stringify(validReceipt));
  assert.deepEqual(readDownloadedReceipts(root), [validReceipt]);
});

test("publication retains exact named artifact directories for one or many segments", (t) => {
  const { root, results } = artifactFixture(t);
  for (const index of [0, 1]) {
    fs.mkdirSync(`${results}/jarvis-review-123-1-${index}`);
    fs.writeFileSync(
      `${results}/jarvis-review-123-1-${index}/result.json`,
      JSON.stringify({ ...validReceipt, index }),
    );
    assert.deepEqual(
      readDownloadedReceipts(root, index === 0 ? [0] : [0, 1]),
      Array.from({ length: index + 1 }, (_, index) => ({
        ...validReceipt,
        index,
      })),
    );
  }
});

for (const invalid of [
  "multiple-expected",
  "wrong-index",
  "oversized",
  "symlink",
  "extra-file",
  "wrong-name",
  "invalid-json",
]) {
  test(`publication refuses invalid flat artifact: ${invalid}`, (t) => {
    const { root, results } = artifactFixture(t);
    const file = `${results}/result.json`;
    fs.writeFileSync(
      file,
      invalid === "oversized"
        ? " ".repeat(70001)
        : invalid === "invalid-json"
          ? "{"
          : JSON.stringify({
              ...validReceipt,
              index: invalid === "wrong-index" ? 1 : 0,
            }),
    );
    if (invalid === "symlink") {
      fs.renameSync(file, `${root}/target`);
      fs.symlinkSync(`${root}/target`, file);
    }
    if (invalid === "extra-file")
      fs.writeFileSync(`${results}/extra.json`, "{}");
    if (invalid === "wrong-name") fs.renameSync(file, `${results}/other.json`);
    assert.deepEqual(
      readDownloadedReceipts(
        root,
        invalid === "multiple-expected" ? [0, 1] : [0],
      ),
      [],
    );
  });
}

for (const invalid of [
  "wrong-run",
  "wrong-attempt",
  "padded-index",
  "wrong-receipt-index",
  "directory-symlink",
  "extra-child",
]) {
  test(`publication refuses invalid named artifact: ${invalid}`, (t) => {
    const { root, results } = artifactFixture(t);
    const name =
      invalid === "wrong-run"
        ? "jarvis-review-124-1-0"
        : invalid === "wrong-attempt"
          ? "jarvis-review-123-2-0"
          : invalid === "padded-index"
            ? "jarvis-review-123-1-00"
            : "jarvis-review-123-1-0";
    const directory = `${results}/${name}`;
    fs.mkdirSync(directory);
    fs.writeFileSync(
      `${directory}/result.json`,
      JSON.stringify({
        ...validReceipt,
        index: invalid === "wrong-receipt-index" ? 1 : 0,
      }),
    );
    if (invalid === "directory-symlink") {
      fs.renameSync(directory, `${root}/target`);
      fs.symlinkSync(`${root}/target`, directory);
    }
    if (invalid === "extra-child")
      fs.writeFileSync(`${directory}/extra.json`, "{}");
    assert.deepEqual(readDownloadedReceipts(root), []);
  });
}
