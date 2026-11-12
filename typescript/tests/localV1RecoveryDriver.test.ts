import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { convexToJson, type Value } from "convex/values";

import {
  LOCAL_V1_RECOVERY_MANUAL_STEPS,
  localV1RestartProofPassed,
  renderLocalV1RestartProofEvidence,
  runLocalV1RestartProof,
  type LocalV1RestartProofConfig,
} from "../src/backup/v4/localV1RecoveryDriver.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";

const DELIVERY_TOKEN = "local-v1-recovery-delivery-token-0000";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lv1-recovery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Isolated Convex stub: serves the task/build/quote GETs the restart proof needs. */
async function isolatedConvexStub(ids: {
  taskId: string;
  buildId: string;
  quoteId: string;
}): Promise<string> {
  const server = http.createServer((req, response) => {
    if (req.method !== "POST" || req.url !== "/api/query") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { path?: string };
      let value: Value = null;
      if (body.path === "tasks:list") {
        value = [
          { _id: ids.taskId, title: "live-task", completed: false, category: "home", createdAt: 1 },
        ];
      } else if (body.path === "builds:get") {
        value = {
          _id: ids.buildId,
          name: "live-build",
          kind: "boat",
          status: "active",
          createdAt: 4,
          updatedAt: 5,
        };
      } else if (body.path === "quotes:get") {
        value = {
          aggregate: {
            _id: "agg-1",
            _creationTime: 1,
            quoteId: ids.quoteId,
            ownerId: "jarvis-cli",
            clientId: "client-1",
            number: "Q-RECOVERY",
            currentRevision: 1,
            currentRevisionId: "rev-1",
            aggregateVersion: 1,
            commercialStatus: "open",
            createdAt: 1,
            updatedAt: 1,
          },
          revision: {
            _id: "rev-1",
            _creationTime: 1,
            revisionId: "rev-1",
            ownerId: "jarvis-cli",
            quoteId: ids.quoteId,
            revision: 1,
            revisionVersion: 1,
            status: "draft",
            lineItems: [{ description: "keel", quantity: 1, unitPrice: 10 }],
            subtotal: 10,
            tax: 0,
            total: 10,
            currency: "AUD",
            termsIncluded: false,
            createdAt: 1,
            updatedAt: 1,
          },
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", value: convexToJson(value) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Isolated Convex stub did not bind.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function prepareJsonDirectory(): Promise<{ jsonDirectory: string; clientId: string }> {
  const root = await tempDir();
  const jsonDirectory = path.join(root, "json");
  await fs.mkdir(jsonDirectory);
  const clients = new JsonClientStore(path.join(jsonDirectory, "jarvis-clients.json"), () => {});
  const client = await clients.add({ name: "Ada", contacts: [] });
  return { jsonDirectory, clientId: client.id };
}

async function baseConfig(): Promise<{
  config: LocalV1RestartProofConfig;
  liveDirectory: string;
}> {
  const { jsonDirectory, clientId } = await prepareJsonDirectory();
  const liveRoot = await tempDir();
  const liveDirectory = path.join(liveRoot, "live");
  await fs.mkdir(liveDirectory);
  await fs.writeFile(path.join(liveDirectory, "sentinel.txt"), "keep\n", "utf8");
  const ids = {
    clientId,
    taskId: "task-recovery",
    buildId: "build-recovery",
    quoteId: "quote-recovery",
  };
  const isolatedConvexUrl = await isolatedConvexStub(ids);
  return {
    liveDirectory,
    config: {
      isolatedConvexUrl,
      configuredConvexUrl: "https://configured.example",
      deliveryRuntimeToken: DELIVERY_TOKEN,
      jsonDirectory,
      liveDirectory,
      ids,
      sourceSha: SHA,
    },
  };
}

describe("Local V1 recovery driver — restart proof", () => {
  it("proves the restart, records evidence, and leaves the live directory unchanged", async () => {
    const { config, liveDirectory } = await baseConfig();
    const record = await runLocalV1RestartProof(config);

    assert.equal(record.quoteRecovered, true);
    assert.equal(record.configuredUrlRefused, true);
    assert.equal(record.clientMatched, true);
    assert.equal(record.taskMatched, true);
    assert.equal(record.buildMatched, true);
    assert.equal(record.liveDirectoryUnchanged, true);
    assert.match(record.quoteBodySha256, /^[a-f0-9]{64}$/);
    assert.equal(record.isolatedEndpoint.startsWith("127.0.0.1:"), true);
    assert.equal(localV1RestartProofPassed(record), true);

    const evidence = renderLocalV1RestartProofEvidence(record);
    assert.match(evidence, /host restart proof/);
    assert.match(evidence, new RegExp(record.quoteBodySha256));
    assert.equal(evidence.includes(DELIVERY_TOKEN), false);
    for (const step of LOCAL_V1_RECOVERY_MANUAL_STEPS) {
      assert.equal(evidence.includes(`- [ ] ${step}`), true);
    }

    assert.equal(await fs.readFile(path.join(liveDirectory, "sentinel.txt"), "utf8"), "keep\n");
  });

  it("refuses a missing delivery token before touching the live directory", async () => {
    const { config } = await baseConfig();
    await assert.rejects(
      () => runLocalV1RestartProof({ ...config, deliveryRuntimeToken: "  " }),
      /requires JARVIS_DELIVERY_RUNTIME_TOKEN/,
    );
  });

  it("refuses a non-loopback isolated URL", async () => {
    const { config } = await baseConfig();
    await assert.rejects(
      () => runLocalV1RestartProof({ ...config, isolatedConvexUrl: "http://198.51.100.7:3210" }),
      /not a loopback host/,
    );
  });

  it("refuses localhost when every resolved address is non-loopback before invoking the runner", async () => {
    const { config } = await baseConfig();
    let runnerCalls = 0;
    let resolvedHost = "";
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, isolatedConvexUrl: "http://localhost:3210" },
          {
            resolveHostAddresses: async (host) => {
              resolvedHost = host;
              return ["192.0.2.10"];
            },
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be called");
            },
          },
        ),
      /not a loopback host/,
    );
    assert.equal(resolvedHost, "localhost");
    assert.equal(runnerCalls, 0);
  });

  it("refuses localhost when resolved answers mix loopback and non-loopback", async () => {
    const { config } = await baseConfig();
    let runnerCalls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, isolatedConvexUrl: "http://localhost:3210" },
          {
            resolveHostAddresses: async () => ["127.0.0.1", "2001:db8::1"],
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be called");
            },
          },
        ),
      /not a loopback host/,
    );
    assert.equal(runnerCalls, 0);
  });

  it("accepts all-loopback localhost answers before the existing runner guard", async () => {
    const { config } = await baseConfig();
    let runnerCalls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, isolatedConvexUrl: "http://localhost:3210", configuredConvexUrl: undefined },
          {
            resolveHostAddresses: async () => ["127.0.0.1", "::1", "127.0.0.2"],
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner reached");
            },
          },
        ),
      /runner reached/,
    );
    assert.equal(runnerCalls, 1);
  });

  it("fails closed on failed or empty localhost resolution before invoking the runner", async () => {
    const { config } = await baseConfig();
    for (const resolveHostAddresses of [
      async () => {
        throw new Error("lookup failed");
      },
      async () => [] as string[],
    ]) {
      let runnerCalls = 0;
      await assert.rejects(
        () =>
          runLocalV1RestartProof(
            { ...config, isolatedConvexUrl: "http://localhost:3210" },
            {
              resolveHostAddresses,
              restartRunner: async () => {
                runnerCalls += 1;
                throw new Error("runner should not be called");
              },
            },
          ),
        /could not resolve the isolated Convex URL/,
      );
      assert.equal(runnerCalls, 0);
    }
  });

  it("refuses a cloud isolated URL", async () => {
    const { config } = await baseConfig();
    await assert.rejects(
      () =>
        runLocalV1RestartProof({
          ...config,
          isolatedConvexUrl: "https://happy-animal-123.convex.cloud",
        }),
      /not a loopback host/,
    );
  });

  it("refuses the configured CONVEX_URL as the isolated target", async () => {
    const { config } = await baseConfig();
    await assert.rejects(
      () =>
        runLocalV1RestartProof({
          ...config,
          configuredConvexUrl: config.isolatedConvexUrl,
        }),
      /refuses the configured CONVEX_URL/,
    );
  });

  it("refuses configured loopback aliases at the same port before invoking the runner", async () => {
    const { config } = await baseConfig();
    const port = new URL(config.isolatedConvexUrl).port;
    const aliases = [
      [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
      [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      [`http://[::1]:${port}`, `http://127.0.0.1:${port}`],
      [`http://127.0.0.1:${port}`, `http://[::1]:${port}`],
      [`http://[0:0:0:0:0:0:0:1]:${port}`, `http://[::1]:${port}`],
      [`http://[::ffff:127.0.0.1]:${port}`, `http://127.0.0.1:${port}`],
      [`http://[0:0:0:0:0:ffff:7f00:1]:${port}`, `http://127.0.0.1:${port}`],
      [`http://127.0.0.2:${port}`, `http://127.0.0.1:${port}`],
      [`http://localhost.:${port}`, `http://127.0.0.1:${port}`],
    ] as const;
    for (const [configuredConvexUrl, isolatedConvexUrl] of aliases) {
      let runnerCalls = 0;
      await assert.rejects(
        () =>
          runLocalV1RestartProof(
            { ...config, configuredConvexUrl, isolatedConvexUrl },
            {
              resolveHostAddresses: async () => ["127.0.0.1", "::1"],
              restartRunner: async () => {
                runnerCalls += 1;
                throw new Error("runner should not be called");
              },
            },
          ),
        /refuses the configured CONVEX_URL/,
        `${configuredConvexUrl} must be refused against ${isolatedConvexUrl}`,
      );
      assert.equal(runnerCalls, 0);
    }
  });

  it("checks every resolved configured address before invoking the runner", async () => {
    const { config } = await baseConfig();
    const port = new URL(config.isolatedConvexUrl).port;
    let runnerCalls = 0;
    let resolvedHost = "";
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, configuredConvexUrl: `http://configured.local:${port}` },
          {
            resolveHostAddresses: async (host) => {
              resolvedHost = host;
              return ["192.0.2.10", "::1"];
            },
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be called");
            },
          },
        ),
      /refuses the configured CONVEX_URL/,
    );
    assert.equal(resolvedHost, "configured.local");
    assert.equal(runnerCalls, 0);
  });

  it("fails closed when a same-port configured host cannot be resolved", async () => {
    const { config } = await baseConfig();
    const port = new URL(config.isolatedConvexUrl).port;
    let runnerCalls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, configuredConvexUrl: `http://configured.local:${port}` },
          {
            resolveHostAddresses: async () => {
              throw new Error("lookup failed");
            },
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be called");
            },
          },
        ),
      /could not resolve the configured CONVEX_URL/,
    );
    assert.equal(runnerCalls, 0);
  });

  it("times out an unresolved same-port configured host before invoking the runner", async () => {
    const { config } = await baseConfig();
    const port = new URL(config.isolatedConvexUrl).port;
    let runnerCalls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, configuredConvexUrl: `http://configured.local:${port}` },
          {
            resolveHostAddresses: async () => new Promise<readonly string[]>(() => {}),
            restartRunner: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be called");
            },
          },
        ),
      /could not resolve the configured CONVEX_URL/,
    );
    assert.equal(runnerCalls, 0);
  });

  it("fails closed when the restart runner throws, leaving the live directory unchanged", async () => {
    const { config, liveDirectory } = await baseConfig();
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...config, configuredConvexUrl: undefined },
          {
            restartRunner: async () => {
              throw new Error("isolated backend unreachable");
            },
          },
        ),
      /isolated backend unreachable/,
    );
    assert.equal(await fs.readFile(path.join(liveDirectory, "sentinel.txt"), "utf8"), "keep\n");
  });
});
