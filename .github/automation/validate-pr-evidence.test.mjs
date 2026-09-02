import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../workflows/copilot-check.yml", import.meta.url);
const templateUrl = new URL("../PULL_REQUEST_TEMPLATE.md", import.meta.url);
const autobuildUrl = new URL(
  "../workflows/jarvis-autobuild.yml",
  import.meta.url,
);

function extractGithubScript(workflow) {
  const lines = workflow.split("\n");
  const markerIndex = lines.findIndex((line) =>
    /^\s+script:\s*\|\s*$/.test(line),
  );
  assert.notEqual(
    markerIndex,
    -1,
    "workflow must contain a github-script block",
  );

  const markerIndent = lines[markerIndex].match(/^\s*/)[0].length;
  const scriptLines = [];
  for (const line of lines.slice(markerIndex + 1)) {
    const indent = line.match(/^\s*/)[0].length;
    if (line.trim() && indent <= markerIndent) break;
    scriptLines.push(line);
  }
  const contentIndent = Math.min(
    ...scriptLines
      .filter((line) => line.trim())
      .map((line) => line.match(/^\s*/)[0].length),
  );
  return scriptLines.map((line) => line.slice(contentIndent)).join("\n");
}

async function evaluateEvidence({ body = "", paths = [] }) {
  const workflow = fs.readFileSync(workflowUrl, "utf8");
  const script = extractGithubScript(workflow);
  const failures = [];
  const context = {
    repo: { owner: "Benny3840RG", repo: "Jarvis" },
    payload: { pull_request: { body, number: 415 } },
  };
  const github = {
    paginate: async (_method, _options) =>
      paths.map((filename) => ({ filename })),
    rest: {
      pulls: {
        listFiles: async () => ({
          data: paths.slice(0, 100).map((filename) => ({ filename })),
        }),
      },
    },
  };
  const core = { setFailed: (message) => failures.push(message) };
  const run = new Function(
    "context",
    "github",
    "core",
    `return (async () => {\n${script}\n})();`,
  );
  await run(context, github, core);
  return failures.join("\n");
}

test("documentation-only changes do not require unrelated evidence headings", async () => {
  assert.equal(
    await evaluateEvidence({ paths: ["docs/runbooks/development.md"] }),
    "",
  );
});

test("HTTP changes require only the relevant evidence line", async () => {
  const failure = await evaluateEvidence({
    paths: [
      "typescript/src/http/toolActionController.ts",
      "typescript/tests/http.test.ts",
    ],
    body: "# PR Evidence\n\n- HTTP / MCP: Request validation remains fail-closed at the existing controller boundary.",
  });
  assert.equal(failure, "");
});

test("a relevant evidence line may use N/A only with a real reason", async () => {
  const failure = await evaluateEvidence({
    paths: [
      "typescript/src/http/toolActionController.ts",
      "typescript/tests/http.test.ts",
    ],
    body: "# PR Evidence\n\n- HTTP / MCP: N/A — controller formatting changed without altering the endpoint contract.",
  });
  assert.equal(failure, "");
});

test("TypeScript source changes still require companion tests", async () => {
  const failure = await evaluateEvidence({
    paths: ["typescript/src/http/toolActionController.ts"],
    body: "# PR Evidence\n\n- HTTP / MCP: Request validation remains fail-closed at the existing controller boundary.",
  });
  assert.match(failure, /touches no test file/i);
});

test("evidence rules inspect changed files beyond the first GitHub page", async () => {
  const paths = Array.from(
    { length: 100 },
    (_, index) => `docs/archive/${index}.md`,
  );
  paths.push("typescript/src/http/toolActionController.ts");

  const failure = await evaluateEvidence({ paths });
  assert.match(failure, /# PR Evidence/);
  assert.match(failure, /touches no test file/i);
});

test("workflow and template describe evidence rather than pretending to be a review", () => {
  const workflow = fs.readFileSync(workflowUrl, "utf8");
  const template = fs.readFileSync(templateUrl, "utf8");
  const autobuild = fs.readFileSync(autobuildUrl, "utf8");

  assert.match(workflow, /^name: PR Evidence Check$/m);
  assert.match(workflow, /^  pr-evidence:$/m);
  assert.match(template, /^# PR Evidence$/m);
  assert.doesNotMatch(template, /^# Copilot Review$/m);
  assert.doesNotMatch(template, /Tests & Checks:\s*\[\.\.\.\]/);
  assert.match(template, /AI review.*advisory/i);
  assert.match(autobuild, /"pr-evidence"/);
  assert.doesNotMatch(autobuild, /"copilot-review-section"/);
});
