import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import ts from "typescript";

import { githubMergeArguments } from "../src/development/githubMergeArguments.js";
import {
  AUTHORITY_INVARIANTS,
  AUTHORITY_RESPONSIBILITIES,
  LAYER_OWNERSHIP,
  OWNER_ONLY_RESPONSIBILITIES,
  type AuthorityLayer,
} from "../src/governance/authorityContract.js";
import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { startJarvisMcpHttpServer } from "../src/mcp/httpServer.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { MCP_TOOL_OPERATIONS, mcpExposedOperations } from "../src/mcp/operationContract.js";

const TYPESCRIPT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SELF_PACKAGE = (
  JSON.parse(readFileSync(join(TYPESCRIPT_ROOT, "package.json"), "utf8")) as { name: string }
).name;

function readTypescriptFile(relativePath: string): string {
  return readFileSync(join(TYPESCRIPT_ROOT, relativePath), "utf8");
}

type OpenApiOperationText = { key: string; text: string };

/**
 * Each operation as `METHOD /path` plus its operationId, summary and tags. Free-text
 * descriptions are left out: they name the Convex "deployment" in unrelated contexts.
 */
function openApiOperations(): OpenApiOperationText[] {
  const document = JSON.parse(readTypescriptFile("openapi/jarvis.openapi.json")) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const operations: OpenApiOperationText[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const declared = [operation.operationId, operation.summary];
      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      operations.push({ key, text: [key, ...declared, ...tags].join(" ") });
    }
  }
  return operations;
}

function typescriptFilesUnder(relativeDir: string): string[] {
  const entries = readdirSync(join(TYPESCRIPT_ROOT, relativeDir), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Every module specifier in a source file, read from its syntax tree: static and
 * side-effect imports, re-exports, `import x = require(...)`, `require(...)`,
 * `import(...)` and import types. A specifier that is not a plain string literal
 * (a template with substitutions, a concatenation, a variable) cannot be resolved
 * statically, so it is reported as `null`. So is any reference to `createRequire`, and any
 * use of `require` other than a direct call.
 */
function moduleSpecifiers(fileName: string, text: string): (string | null)[] {
  const specifiers: (string | null)[] = [];
  const literal = (node: ts.Node | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isExternalModuleReference(node)) {
      specifiers.push(literal(node.expression));
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      specifiers.push(ts.isLiteralTypeNode(argument) ? literal(argument.literal) : null);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || calleeName === "require") {
        specifiers.push(literal(node.arguments[0]));
      }
    } else if (
      ts.isIdentifier(node) &&
      (node.text === "createRequire" ||
        (node.text === "require" &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)))
    ) {
      // `createRequire`, or `require` used as a value (`const load = require`), hides
      // the loaded module from static resolution.
      specifiers.push(null);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true));
  return specifiers;
}

/** Governed approval-boundary modules that the preview reaches only to propose and execute. */
const APPROVAL_BOUNDARY = ["src/actions/toolActions.ts", "src/persistence/convexToolActions.ts"];

/**
 * Preview-reachable modules permitted to *name* the approval-token env vars. The two
 * governed-boundary modules handle the token; `workerAuthority` names them only to assert
 * a versioned worker holds none (it guards against the token, it never reads a value). No
 * other reached module may name the token.
 */
const APPROVAL_TOKEN_NAMED = [
  ...APPROVAL_BOUNDARY,
  "src/preview/temporalPass/temporal/workerAuthority.ts",
].sort();

/**
 * Whether a file references an `approve` operation: `x.approve`, `x["approve"]`, a bare
 * `approve(...)` call, or an import binding named `approve`. Method declarations are not
 * references. Aliasing through a computed key or a renamed variable is not detected.
 */
function referencesApprove(fileName: string, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "approve") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "approve") ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "approve") ||
      (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "approve")
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true));
  return found;
}

function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Source files reachable from `roots` through relative imports, with any unresolved imports. */
function relativeImportClosure(roots: readonly string[]): {
  files: Set<string>;
  unresolved: string[];
} {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of moduleSpecifiers(file, readFileSync(file, "utf8"))) {
      if (specifier === null) {
        unresolved.push(`${file}: non-literal import or require`);
        continue;
      }
      if (!specifier.startsWith(".")) {
        // Bare specifiers are packages only while the repository defines no import
        // aliases; the test asserts that. Anything that could name repository code
        // without a relative path is reported instead of skipped.
        if (
          specifier.startsWith("/") ||
          specifier.startsWith("#") ||
          specifier === SELF_PACKAGE ||
          specifier.startsWith(`${SELF_PACKAGE}/`) ||
          /(^|\/)src\//.test(specifier)
        ) {
          unresolved.push(`${file}: ${specifier}`);
        }
        continue;
      }
      const target = resolveRelativeModule(file, specifier);
      if (target) pending.push(target);
      else unresolved.push(`${file}: ${specifier}`);
    }
  }
  return { files, unresolved };
}

/**
 * Titles of tests actually declared in a file: string-literal first arguments of
 * `it(...)` or `test(...)` calls in the parsed syntax tree. A title that survives
 * only in a comment or an unrelated string does not count, and neither does a
 * skipped (`it.skip`) or todo test.
 */
function declaredTestTitles(relativePath: string): Set<string> {
  const source = ts.createSourceFile(
    relativePath,
    readTypescriptFile(relativePath),
    ts.ScriptTarget.Latest,
    true,
  );
  const titles = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "it" || node.expression.text === "test")
    ) {
      const [title] = node.arguments;
      if (title && ts.isStringLiteralLike(title)) titles.add(title.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/**
 * `freePort` releases its probe before the server binds, so another process can take the
 * port in between. Retry on EADDRINUSE instead of failing on that race.
 */
async function startMcpServerOnFreePort(
  api: JarvisMcpConfig["api"],
  fetchImpl: typeof fetch,
): Promise<Awaited<ReturnType<typeof startJarvisMcpHttpServer>>> {
  for (let attempt = 1; ; attempt += 1) {
    const config: JarvisMcpConfig = { host: "127.0.0.1", port: await freePort(), api };
    try {
      return await startJarvisMcpHttpServer(config, new JarvisApiClient(api, fetchImpl));
    } catch (error: unknown) {
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!inUse || attempt >= 5) throw error;
    }
  }
}

describe("Authority contract", () => {
  it("assigns every responsibility to exactly one layer", () => {
    const owners = new Map<string, AuthorityLayer[]>();
    for (const [layer, responsibilities] of Object.entries(LAYER_OWNERSHIP)) {
      for (const responsibility of responsibilities) {
        owners.set(responsibility, [
          ...(owners.get(responsibility) ?? []),
          layer as AuthorityLayer,
        ]);
      }
    }
    for (const responsibility of AUTHORITY_RESPONSIBILITIES) {
      const layers = owners.get(responsibility) ?? [];
      assert.equal(layers.length, 1, `${responsibility} is owned by [${layers.join(", ")}]`);
    }
    assert.deepEqual([...owners.keys()].sort(), [...AUTHORITY_RESPONSIBILITIES].sort());
  });

  it("reserves merge, production deployment and authority-policy change for Benny", () => {
    for (const responsibility of OWNER_ONLY_RESPONSIBILITIES) {
      assert.ok(LAYER_OWNERSHIP.benny.includes(responsibility), responsibility);
    }
    assert.deepEqual([...LAYER_OWNERSHIP.benny].sort(), [...OWNER_ONLY_RESPONSIBILITIES].sort());
  });

  it("uses unique invariant ids that cite constitutional laws", () => {
    const constitution = readFileSync(
      join(TYPESCRIPT_ROOT, "..", "JARVIS_CONSTITUTION.md"),
      "utf8",
    );
    const ids = AUTHORITY_INVARIANTS.map((invariant) => invariant.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const invariant of AUTHORITY_INVARIANTS) {
      assert.ok(invariant.laws.length > 0, `${invariant.id} cites no law`);
      for (const law of invariant.laws) {
        assert.ok(constitution.includes(`### ${law} `), `${invariant.id} cites unknown ${law}`);
      }
    }
  });

  it("binds every enforced or guarded invariant to a test that still exists under that title", () => {
    for (const invariant of AUTHORITY_INVARIANTS) {
      if (invariant.status === "planned") continue;
      assert.ok(invariant.evidence.length > 0, `${invariant.id} has no evidence`);
      for (const evidence of invariant.evidence) {
        const inPassSuite = evidence.file.startsWith("tests/pass/");
        assert.equal(
          evidence.suite === "temporal-pass",
          inPassSuite,
          `${invariant.id}: ${evidence.file} is labelled with the wrong suite`,
        );
        assert.ok(
          declaredTestTitles(evidence.file).has(evidence.test),
          `${invariant.id}: ${evidence.file} has no test titled "${evidence.test}"`,
        );
      }
    }
  });

  it("names a roadmap PR for every invariant that is not yet enforced", () => {
    const rows = readTypescriptFile("docs/ROADMAP.md").split("\n");
    for (const invariant of AUTHORITY_INVARIANTS) {
      if (invariant.status === "enforced") continue;
      const row = rows.find((line) =>
        new RegExp(`^\\|\\s*${invariant.deliveredBy}\\s*\\|`).test(line),
      );
      assert.ok(
        row,
        `${invariant.id} names PR ${invariant.deliveredBy}, which the roadmap does not list`,
      );
      assert.ok(
        row.includes(invariant.id),
        `roadmap row for PR ${invariant.deliveredBy} does not track ${invariant.id}`,
      );
    }
  });
});

describe("Authority invariants against current code", () => {
  it("exposes no approve, execute, revoke, merge or deploy operation through MCP", () => {
    const forbiddenSegment = /^(approve|execute|revoke|merge|deploy)/i;
    for (const operation of mcpExposedOperations()) {
      const segments = operation.split(" ")[1]!.split("/");
      for (const segment of segments) {
        assert.doesNotMatch(segment, forbiddenSegment, `MCP reaches ${operation}`);
      }
      assert.doesNotMatch(operation, /merge|deploy/i, `MCP reaches ${operation}`);
    }
    for (const tool of Object.keys(MCP_TOOL_OPERATIONS)) {
      assert.doesNotMatch(tool, /merge|deploy|approve|execute|revoke/i, `MCP tool ${tool}`);
    }
  });

  it("offers no deployment operation in the operator API or MCP surface", () => {
    const deployment = /deploy|release|promote|rollout/i;
    for (const { key, text } of openApiOperations()) {
      assert.doesNotMatch(text, deployment, `operator API offers ${key}`);
    }
    for (const operation of mcpExposedOperations()) {
      assert.doesNotMatch(operation, deployment, `MCP reaches ${operation}`);
    }
    for (const tool of Object.keys(MCP_TOOL_OPERATIONS)) {
      assert.doesNotMatch(tool, deployment, `MCP tool ${tool}`);
    }
  });

  it("requires an exact reviewed head SHA and owner-level risk for the governed merge", () => {
    const valid = {
      subjectId: "mission-1",
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 1,
      baseBranch: "main",
      reviewedHeadSha: "a".repeat(40),
      mergeMethod: "merge",
      authorityEnvelopeHash: "envelope",
      policyDecisionFingerprint: "decision",
      effectiveRisk: 4,
    };
    assert.equal(githubMergeArguments.safeParse(valid).success, true);
    for (const reviewedHeadSha of ["latest", "HEAD", "main", "a".repeat(39), ""]) {
      assert.equal(
        githubMergeArguments.safeParse({ ...valid, reviewedHeadSha }).success,
        false,
        reviewedHeadSha,
      );
    }
    assert.equal(githubMergeArguments.safeParse({ ...valid, effectiveRisk: 3 }).success, false);
  });

  it("keeps the Temporal PASS preview away from approval credentials and approve calls", () => {
    const manifest = JSON.parse(readTypescriptFile("package.json")) as { imports?: unknown };
    assert.equal(manifest.imports, undefined, "package.json subpath imports would alias modules");
    for (const config of ["tsconfig.json", "convex/tsconfig.json"]) {
      // Resolve `extends`, so options inherited from a parent config are checked too.
      const parsed = ts.getParsedCommandLineOfConfigFile(join(TYPESCRIPT_ROOT, config), undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      });
      assert.ok(parsed, `${config} could not be parsed`);
      assert.equal(parsed.options.paths, undefined, `${config} path aliases would bypass the scan`);
      assert.equal(parsed.options.baseUrl, undefined, `${config} baseUrl would bypass the scan`);
    }
    const files = typescriptFilesUnder("src/preview/temporalPass");
    assert.ok(files.length > 0);
    const closure = relativeImportClosure(files);
    assert.deepEqual(closure.unresolved, [], "preview imports that cannot be checked");
    const reached = [...closure.files].map((file) => ({
      path: relative(TYPESCRIPT_ROOT, file).split(sep).join("/"),
      source: readFileSync(file, "utf8"),
    }));
    const approvalToken = /approvalToken|JARVIS_APPROVAL_TOKEN/;
    assert.deepEqual(
      reached.filter(({ path }) => path.startsWith("src/http/")).map(({ path }) => path),
      [],
      "the preview reaches the HTTP layer",
    );
    assert.deepEqual(
      reached
        .filter(({ path }) => !APPROVAL_BOUNDARY.includes(path))
        .filter(({ path, source }) => referencesApprove(path, source))
        .map(({ path }) => path),
      [],
      "a module the preview reaches references approve outside the approval boundary",
    );
    assert.deepEqual(
      reached
        .filter(
          ({ path, source }) =>
            path.startsWith("src/preview/") &&
            approvalToken.test(source) &&
            !APPROVAL_TOKEN_NAMED.includes(path),
        )
        .map(({ path }) => path),
      [],
      "a preview module names the approval token outside the allowlist",
    );
    // Only the governed boundary (which handles the token) and the worker-authority
    // guard (which forbids it) may name the approval token. Any other reached module fails.
    assert.deepEqual(
      reached
        .filter(({ source }) => approvalToken.test(source))
        .map(({ path }) => path)
        .sort(),
      APPROVAL_TOKEN_NAMED,
      "approval-token naming outside the reviewed boundary and guard",
    );
  });

  it("refuses an unadvertised MCP tool without calling the operator API", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const api = {
      baseUrl: new URL("http://127.0.0.1:3000/"),
      serviceToken: "authority-test-token",
    };
    const running = await startMcpServerOnFreePort(api, fetchImpl);
    const client = new Client({ name: "jarvis-authority-test", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
      const advertised = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["merge_pull_request", "approve_tool_action", "execute_tool_action"]) {
        assert.ok(!advertised.includes(name), `${name} is advertised`);
        const outcome = await client
          .callTool({ name, arguments: {} })
          .then((result) => (result.isError === true ? "refused" : "executed"))
          .catch(() => "refused");
        assert.equal(outcome, "refused", name);
      }
      assert.deepEqual(calls, []);
    } finally {
      await client.close();
      await running.close();
    }
  });
});
