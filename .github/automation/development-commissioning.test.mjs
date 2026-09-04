import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflowUrl = new URL(
  "../workflows/development-commissioning.yml",
  import.meta.url,
);

test("commissioning requires the dedicated Actions delivery credential before smoke", () => {
  const workflow = fs.readFileSync(workflowUrl, "utf8");

  assert.match(
    workflow,
    /JARVIS_DELIVERY_RUNTIME_TOKEN:\s*\$\{\{\s*secrets\.JARVIS_DELIVERY_RUNTIME_TOKEN\s*\}\}/,
  );
  assert.match(
    workflow,
    /for variable in CONVEX_DEPLOY_KEY JARVIS_SERVICE_TOKEN OPENAI_API_KEY JARVIS_DELIVERY_RUNTIME_TOKEN;/,
  );
  assert.doesNotMatch(workflow, /convex env get JARVIS_DELIVERY_RUNTIME_TOKEN/);
});
