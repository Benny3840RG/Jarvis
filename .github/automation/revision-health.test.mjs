import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_CODEQL_LANGUAGES,
  evaluateRevisionHealth,
  referencedRunIds,
  runIdFromCheck,
  sourceRevisionIsOnMain,
} from "./revision-health.mjs";

const TS_RUN = 111;
const CODEQL_RUN = 222;

function check(name, { run = TS_RUN, status = "completed", conclusion = "success" } = {}) {
  return {
    name,
    status,
    conclusion,
    id: Math.floor(Math.random() * 1e9),
    app: { slug: "github-actions" },
    details_url: `https://github.com/Benny3840RG/Jarvis/actions/runs/${run}/job/1`,
  };
}

function healthyInput() {
  const checkRuns = [
    check("automation-policy"),
    check("typecheck-lint-format-test"),
    check("jarvis-console-01-build"),
    ...EXPECTED_CODEQL_LANGUAGES.map((lang) => check(`Analyze (${lang})`, { run: CODEQL_RUN })),
  ];
  const runPathById = new Map([
    [TS_RUN, ".github/workflows/typescript.yml"],
    [CODEQL_RUN, "dynamic/github-code-scanning/codeql"],
  ]);
  return { checkRuns, runPathById };
}

test("runIdFromCheck reads the run id from either url field", () => {
  assert.equal(runIdFromCheck({ details_url: ".../actions/runs/999/job/2" }), 999);
  assert.equal(runIdFromCheck({ html_url: ".../actions/runs/1234" }), 1234);
  assert.ok(Number.isNaN(runIdFromCheck({})));
});

test("referencedRunIds covers only checks that influence the verdict", () => {
  const ids = referencedRunIds([
    check("automation-policy", { run: 1 }),
    check("Analyze (ruby)", { run: 2 }),
    check("some-unrelated-check", { run: 3 }),
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2]);
});

test("evaluateRevisionHealth passes for a fully green trusted revision", () => {
  const result = evaluateRevisionHealth(healthyInput());
  assert.deepEqual(result, { ok: true, problems: [], pending: [] });
});

test("evaluateRevisionHealth flags a failed required check", () => {
  const input = healthyInput();
  input.checkRuns.find((c) => c.name === "typecheck-lint-format-test").conclusion = "failure";
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes("typecheck-lint-format-test:failure"));
});

test("evaluateRevisionHealth treats a missing CodeQL analysis as pending, never ok", () => {
  const input = healthyInput();
  input.checkRuns = input.checkRuns.filter((c) => c.name !== "Analyze (ruby)");
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  assert.ok(result.pending.includes("CodeQL(ruby)"));
  assert.deepEqual(result.problems, []);
});

test("evaluateRevisionHealth treats neutral CodeQL as a problem, not success", () => {
  const input = healthyInput();
  input.checkRuns.find((c) => c.name === "Analyze (python)").conclusion = "neutral";
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith("CodeQL(python):neutral")));
});

test("evaluateRevisionHealth rejects a required check from an untrusted producer", () => {
  const input = healthyInput();
  input.runPathById.set(TS_RUN, ".github/workflows/somebody-elses.yml");
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes("automation-policy: untrusted producer"));
});

test("evaluateRevisionHealth ignores a CodeQL analysis from an untrusted producer, leaving it pending", () => {
  const input = healthyInput();
  input.runPathById.set(CODEQL_RUN, "dynamic/github-code-quality/codeql");
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  for (const lang of EXPECTED_CODEQL_LANGUAGES) {
    assert.ok(result.pending.includes(`CodeQL(${lang})`));
  }
});

test("evaluateRevisionHealth rejects a check-run not attributed to github-actions", () => {
  const input = healthyInput();
  input.checkRuns.find((c) => c.name === "automation-policy").app = { slug: "third-party" };
  const result = evaluateRevisionHealth(input);
  assert.equal(result.ok, false);
  assert.ok(result.pending.includes("automation-policy"));
});

test("sourceRevisionIsOnMain accepts only identical or ancestor revisions", () => {
  assert.equal(sourceRevisionIsOnMain("identical"), true);
  assert.equal(sourceRevisionIsOnMain("ahead"), true);
  assert.equal(sourceRevisionIsOnMain("behind"), false);
  assert.equal(sourceRevisionIsOnMain("diverged"), false);
  assert.equal(sourceRevisionIsOnMain(undefined), false);
});
