import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Console 01 calls Convex directly (ConvexHttpClient), bypassing the main
 * Jarvis HTTP layer entirely, so the repo-root parity tests
 * (httpRouteContract.test.ts, mcpOperationBinding.test.ts,
 * mcpOperationContract.test.ts) never see it and can't enforce that its
 * Convex calls stay a subset of the documented OpenAPI surface. This file is
 * that check, scoped to Console 01 specifically.
 *
 * Each entry: a Convex function this file calls, and the OpenAPI operation
 * that documents equivalent capability. Read/remove map straight to a real
 * HTTP route; `notes.create` deliberately has no direct route of its own —
 * it stays behind the governed tool-actions propose/approve/execute flow,
 * which is where its mandatory idempotency/fingerprint contract is actually
 * enforced, so it maps to that generic execute path instead.
 *
 * `toolActions.listRecent` is read-only inspection of the same governed
 * tool-actions register — Console 01 exposes no approve/revoke/execute
 * Convex call, so no further entries are expected for that namespace.
 *
 * `developmentState.listRecent` is a deliberate, documented exception
 * rather than a real mapping: the governed Development mission pipeline
 * (JARVIS Phase 1) has been Convex-native throughout its build, with no
 * NestJS/PersistenceProvider-backed HTTP surface at all yet, unlike
 * tool-actions which already had one. Retrofitting a whole HTTP route
 * (controller, DI wiring, OpenAPI doc, its own tests) purely to satisfy
 * this parity check would be a disproportionate detour for what is,
 * today, read-only console inspection — so `noHttpRouteYet` marks it as a
 * known, intentional gap instead of silently exempting it or faking a
 * mapping to an unrelated route. Should get a real entry once Development
 * state gets an HTTP surface of its own.
 */
const EXPECTED_COVERAGE: {
  functionName: string;
  operation: string;
  noHttpRouteYet?: string;
}[] = [
  { functionName: "anyApi.tasks.listPage", operation: "GET /api/v1/tasks" },
  { functionName: "anyApi.reminders.listPage", operation: "GET /api/v1/reminders" },
  { functionName: "anyApi.notes.listPage", operation: "GET /api/v1/projects/{projectId}/notes" },
  {
    functionName: "anyApi.notes.remove",
    operation: "DELETE /api/v1/projects/{projectId}/notes/{noteId}",
  },
  {
    functionName: "anyApi.notes.create",
    operation: "POST /api/v1/projects/{projectId}/tool-actions",
  },
  {
    functionName: "anyApi.toolActions.listRecent",
    operation: "GET /api/v1/projects/{projectId}/tool-actions",
  },
  {
    functionName: "anyApi.developmentState.listRecent",
    operation: "GET /api/v1/development/missions",
    noHttpRouteYet:
      "Development state is Convex-native with no HTTP/NestJS surface yet; see the header comment above.",
  },
];

async function openApiOperations(): Promise<Set<string>> {
  const raw = await readFile(new URL("../../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as { paths: Record<string, Record<string, unknown>> };
  const operations = new Set<string>();
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (methods.has(method)) operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

test("every Convex call Console 01 makes has a documented HTTP/OpenAPI equivalent, or an explicit documented gap", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const operations = await openApiOperations();

  for (const { functionName, operation, noHttpRouteYet } of EXPECTED_COVERAGE) {
    assert.ok(
      source.includes(functionName),
      `Expected index.ts to call ${functionName} — this mapping is stale, update it.`,
    );
    if (noHttpRouteYet) {
      assert.ok(
        noHttpRouteYet.trim().length > 0,
        `${functionName}'s noHttpRouteYet gap must carry a real reason, not an empty string.`,
      );
      continue;
    }
    assert.ok(
      operations.has(operation),
      `${functionName} has no matching OpenAPI operation "${operation}" — Console 01's Convex ` +
        "surface would no longer be a documented subset of the API.",
    );
  }
});

test("Console 01 makes no notes Convex calls beyond the ones this file accounts for", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const calls = new Set(source.match(/anyApi\.notes\.\w+/g) ?? []);
  const accountedFor = new Set(
    EXPECTED_COVERAGE.filter((entry) => entry.functionName.startsWith("anyApi.notes.")).map(
      (entry) => entry.functionName,
    ),
  );
  for (const call of calls) {
    assert.ok(
      accountedFor.has(call),
      `index.ts calls ${call}, which isn't covered by EXPECTED_COVERAGE above — add it and its ` +
        "OpenAPI mapping (or note explicitly why none is needed) so a future notes.* call can't " +
        "silently reintroduce this gap.",
    );
  }
});

test("Console 01 makes no toolActions Convex calls beyond the ones this file accounts for", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const calls = new Set(source.match(/anyApi\.toolActions\.\w+/g) ?? []);
  const accountedFor = new Set(
    EXPECTED_COVERAGE.filter((entry) => entry.functionName.startsWith("anyApi.toolActions.")).map(
      (entry) => entry.functionName,
    ),
  );
  for (const call of calls) {
    assert.ok(
      accountedFor.has(call),
      `index.ts calls ${call}, which isn't covered by EXPECTED_COVERAGE above — add it and its ` +
        "OpenAPI mapping so a future toolActions.* call (e.g. approve/revoke) can't silently " +
        "bypass this parity check.",
    );
  }
});

test("Console 01 makes no developmentState Convex calls beyond the ones this file accounts for", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const calls = new Set(source.match(/anyApi\.developmentState\.\w+/g) ?? []);
  const accountedFor = new Set(
    EXPECTED_COVERAGE.filter((entry) => entry.functionName.startsWith("anyApi.developmentState.")).map(
      (entry) => entry.functionName,
    ),
  );
  for (const call of calls) {
    assert.ok(
      accountedFor.has(call),
      `index.ts calls ${call}, which isn't covered by EXPECTED_COVERAGE above — add it (with a ` +
        "real OpenAPI mapping or an explicit noHttpRouteYet reason) so a future developmentState.* " +
        "call can't silently bypass this parity check.",
    );
  }
});
