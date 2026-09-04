import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflowUrl = new URL(
  "../workflows/development-commissioning.yml",
  import.meta.url,
);

test("commissioning loads and masks the deployed delivery credential before smoke", () => {
  const workflow = fs.readFileSync(workflowUrl, "utf8");
  const loadIndex = workflow.indexOf(
    "npx convex env get JARVIS_DELIVERY_RUNTIME_TOKEN",
  );
  const maskIndex = workflow.indexOf("::add-mask::");
  const exportIndex = workflow.indexOf("JARVIS_DELIVERY_RUNTIME_TOKEN=");
  const smokeIndex = workflow.indexOf("npm run smoke:convex");

  assert.notEqual(
    loadIndex,
    -1,
    "commissioning must load the existing deployment credential",
  );
  assert.ok(
    maskIndex > loadIndex,
    "the loaded credential must be masked before export",
  );
  assert.ok(
    exportIndex > maskIndex,
    "the masked credential must be exported for later steps",
  );
  assert.ok(
    smokeIndex > exportIndex,
    "smoke must run only after credential export",
  );
  assert.doesNotMatch(workflow, /secrets\.JARVIS_DELIVERY_RUNTIME_TOKEN/);
});
