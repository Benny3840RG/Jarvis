import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const TYPESCRIPT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP_DIR = join(TYPESCRIPT_ROOT, "src", "mcp");
const ADAPTER = "src/mcp/sdkAdapter.ts";
const SDK_PACKAGE = "@modelcontextprotocol/sdk";

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every module specifier a file imports/exports-from, read from its syntax tree. */
function moduleSpecifiers(fileName: string, text: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteralLike(literal)) specifiers.push(literal.text);
    } else if (
      // `import sdk = require("@modelcontextprotocol/sdk")` — the CommonJS
      // import-equals form, whose module reference must also be scanned or it
      // would bypass this boundary check.
      ts.isExternalModuleReference(node) &&
      ts.isStringLiteralLike(node.expression)
    ) {
      specifiers.push(node.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true));
  return specifiers;
}

function importsSdk(specifiers: readonly string[]): boolean {
  return specifiers.some(
    (specifier) => specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`),
  );
}

describe("MCP SDK adapter boundary (PR D)", () => {
  const files = tsFilesUnder(MCP_DIR).map((absolute) => ({
    path: relative(TYPESCRIPT_ROOT, absolute).split(sep).join("/"),
    specifiers: moduleSpecifiers(absolute, readFileSync(absolute, "utf8")),
  }));

  it("routes every src/mcp use of @modelcontextprotocol/sdk through the adapter alone", () => {
    assert.ok(files.length > 1, "expected multiple modules under src/mcp");
    const offenders = files
      .filter(({ path }) => path !== ADAPTER)
      .filter(({ specifiers }) => importsSdk(specifiers))
      .map(({ path }) => path);
    assert.deepEqual(
      offenders,
      [],
      `these src/mcp modules import ${SDK_PACKAGE} directly instead of via ${ADAPTER}`,
    );
  });

  it("keeps the adapter a real boundary: it does import the SDK it fronts", () => {
    const adapter = files.find(({ path }) => path === ADAPTER);
    assert.ok(adapter, `${ADAPTER} is missing`);
    assert.equal(
      importsSdk(adapter.specifiers),
      true,
      `${ADAPTER} no longer imports ${SDK_PACKAGE}, so the guard would pass vacuously`,
    );
  });
});
