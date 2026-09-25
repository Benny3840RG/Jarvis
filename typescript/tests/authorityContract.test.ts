import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

function readTypescriptFile(relativePath: string): string {
  return readFileSync(join(TYPESCRIPT_ROOT, relativePath), "utf8");
}

function openApiOperations(): string[] {
  const document = JSON.parse(readTypescriptFile("openapi/jarvis.openapi.json")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const operations: string[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) operations.push(`${method.toUpperCase()} ${path}`);
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

  it("binds every enforced invariant to a test that still exists under that title", () => {
    for (const invariant of AUTHORITY_INVARIANTS) {
      if (invariant.status !== "enforced") continue;
      assert.ok(invariant.evidence.length > 0, `${invariant.id} has no evidence`);
      for (const evidence of invariant.evidence) {
        const inPassSuite = evidence.file.startsWith("tests/pass/");
        assert.equal(
          evidence.suite === "temporal-pass",
          inPassSuite,
          `${invariant.id}: ${evidence.file} is labelled with the wrong suite`,
        );
        const source = readTypescriptFile(evidence.file);
        assert.ok(
          source.includes(`it(${JSON.stringify(evidence.test)}`) ||
            source.includes(`it(\n    ${JSON.stringify(evidence.test)}`),
          `${invariant.id}: ${evidence.file} has no test titled "${evidence.test}"`,
        );
      }
    }
  });

  it("names a roadmap PR for every invariant that is not yet enforced", () => {
    const rows = readTypescriptFile("docs/ROADMAP.md").split("\n");
    for (const invariant of AUTHORITY_INVARIANTS) {
      if (invariant.status !== "planned") continue;
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
    const forbiddenOperation = /\/(approve|execute|revoke)$/;
    for (const operation of mcpExposedOperations()) {
      assert.doesNotMatch(operation, forbiddenOperation, `MCP reaches ${operation}`);
    }
    for (const tool of Object.keys(MCP_TOOL_OPERATIONS)) {
      assert.doesNotMatch(tool, /merge|deploy|approve|execute|revoke/i, `MCP tool ${tool}`);
    }
  });

  it("offers no deployment operation in the operator API or MCP surface", () => {
    const deployment = /deploy|release|promote|rollout/i;
    for (const operation of openApiOperations()) {
      assert.doesNotMatch(operation, deployment, `operator API offers ${operation}`);
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
    const files = typescriptFilesUnder("src/preview/temporalPass");
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /approvalToken|JARVIS_APPROVAL_TOKEN/, file);
      assert.doesNotMatch(source, /\.approve\s*\(/, file);
      assert.doesNotMatch(source, /from\s+["'][./]*\/http\//, file);
    }
  });

  it("refuses an unadvertised MCP tool without calling the operator API", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const config: JarvisMcpConfig = {
      host: "127.0.0.1",
      port: await freePort(),
      api: { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "authority-test-token" },
    };
    const running = await startJarvisMcpHttpServer(
      config,
      new JarvisApiClient(config.api, fetchImpl),
    );
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
