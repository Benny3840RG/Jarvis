import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const convexTsconfig = readFileSync(new URL("../convex/tsconfig.json", import.meta.url), "utf8");

describe("Convex TypeScript configuration", () => {
  it("includes Node globals required by Convex and shared modules", () => {
    assert.match(
      convexTsconfig,
      /"types"\s*:\s*\[\s*"node"\s*\]/,
      "convex/tsconfig.json must opt in to Node types",
    );
  });

  it("keeps the Convex project in the standard type-check command", () => {
    assert.equal(
      packageJson.scripts?.["type-check"],
      "tsc -p tsconfig.json && tsc -p convex/tsconfig.json",
    );
  });
});
