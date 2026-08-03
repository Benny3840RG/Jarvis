import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const convexTsconfigText = readFileSync(
  new URL("../convex/tsconfig.json", import.meta.url),
  "utf8",
);
const convexTsconfig = ts.parseConfigFileTextToJson("convex/tsconfig.json", convexTsconfigText)
  .config as { compilerOptions?: { types?: string[] } };

describe("Convex TypeScript configuration", () => {
  it("includes Node globals required by Convex and shared modules", () => {
    assert.ok(
      convexTsconfig.compilerOptions?.types?.includes("node"),
      "convex/tsconfig.json must opt in to Node types",
    );
  });

  it("keeps the Convex project in the standard type-check command", () => {
    const typeCheck = packageJson.scripts?.["type-check"] ?? "";
    assert.match(typeCheck, /(?:^|&&)\s*tsc\s+-p\s+tsconfig\.json(?:\s|$)/);
    assert.match(typeCheck, /(?:^|&&)\s*tsc\s+-p\s+convex\/tsconfig\.json(?:\s|$)/);
  });
});
