import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// `npx convex deploy` bundles every convex/*.ts module without a "use node"
// directive for the default (V8) runtime, which cannot resolve Node built-ins.
// Type checks and unit tests do not bundle, so a `node:` import reached from
// such a module only fails at deploy time. This walks each default-runtime
// module's relative value imports and refuses any Node built-in.

const TYPESCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_DIR = path.join(TYPESCRIPT_ROOT, "convex");
// Node's own authoritative list, so a bare specifier (`timers`, `vm`, ...) is
// caught as reliably as a `node:`-prefixed one.
const NODE_BUILTINS = new Set(builtinModules);
const IMPORT_PATTERN = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base.replace(/\.js$/, ""), "index.ts"),
  ];
  return candidates.find((candidate) => candidate.endsWith(".ts") && existsSync(candidate));
}

function nodeBuiltinsReachedFrom(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...[...source.matchAll(IMPORT_PATTERN)].map((match) => match[2] ?? ""),
      ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1] ?? ""),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
        found.push(`${path.relative(TYPESCRIPT_ROOT, file)} imports ${specifier}`);
      } else if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        if (resolved !== undefined) stack.push(resolved);
      }
    }
  }
  return found;
}

function defaultRuntimeModules(): string[] {
  return readdirSync(CONVEX_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .map((name) => path.join(CONVEX_DIR, name))
    .filter((file) => !/^\s*["']use node["'];?/m.test(readFileSync(file, "utf8")));
}

describe("Convex default-runtime bundle", () => {
  it("finds the default-runtime modules it guards", () => {
    const modules = defaultRuntimeModules().map((file) => path.basename(file));
    assert.ok(modules.includes("developmentState.ts"));
    assert.ok(!modules.includes("quoteFinalization.ts"), "use node modules are excluded");
  });

  it("detects a Node built-in reached through a relative import", () => {
    const found = nodeBuiltinsReachedFrom(path.join(TYPESCRIPT_ROOT, "src/backup/backup.ts"));
    assert.ok(found.length > 0, "the walker must see node: imports when they exist");
  });

  it("treats every bare Node built-in name as a built-in", () => {
    for (const name of [
      "timers",
      "tty",
      "worker_threads",
      "readline",
      "vm",
      "module",
      "fs/promises",
    ]) {
      assert.ok(NODE_BUILTINS.has(name), name);
    }
  });

  it('never reaches a Node built-in from a module without "use node"', () => {
    const offenders = defaultRuntimeModules().flatMap((file) =>
      nodeBuiltinsReachedFrom(file).map((hit) => `${path.relative(TYPESCRIPT_ROOT, file)}: ${hit}`),
    );
    assert.deepEqual([...new Set(offenders)], []);
  });
});
