import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { convexToJson, type Value } from "convex/values";

import { readRestartedProcess } from "../src/backup/v4/localV1ProcessRestart.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lv1-restart-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Local V1 restarted process", () => {
  it("serves the same client, task, and build after killing the HTTP entrypoint", async () => {
    const root = await tempDir();
    const live = path.join(root, "live");
    const jsonDirectory = path.join(root, "json");
    await fs.mkdir(live);
    await fs.mkdir(jsonDirectory);
    const sentinel = path.join(live, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n", "utf8");
    const clients = new JsonClientStore(path.join(jsonDirectory, "jarvis-clients.json"), () => {});
    const persistence = new JSONPersistence(
      path.join(jsonDirectory, "jarvis-state.json"),
      () => {},
    );
    const builds = new JsonBuildStore(path.join(jsonDirectory, "jarvis-builds.json"), () => {});
    const client = await clients.add({ name: "Ada", contacts: [] });
    const task = await persistence.addTask("live-task", "home");
    const build = await builds.add({ name: "live-build", kind: "tool" });
    const previous = process.env.CONVEX_URL;
    process.env.CONVEX_URL = "https://configured.example";
    try {
      const restarted = await readRestartedProcess({
        jsonDirectory,
        liveDirectory: live,
        clientId: client.id,
        taskId: task.id,
        buildId: build.id,
        quoteId: "quote-not-on-json",
        configuredConvexUrl: process.env.CONVEX_URL,
      });
      assert.equal(restarted.quoteRecovered, false);
      assert.equal(restarted.first.quoteStatus, 503);
      assert.equal(restarted.second.quoteStatus, 503);
      assert.match(restarted.first.clientBody, /Ada/);
      assert.match(restarted.first.taskBody, /live-task/);
      assert.match(restarted.first.buildBody, /live-build/);
      assert.equal(restarted.first.clientBody, restarted.second.clientBody);
      assert.equal(restarted.first.taskBody, restarted.second.taskBody);
      assert.equal(restarted.first.buildBody, restarted.second.buildBody);
    } finally {
      if (previous === undefined) delete process.env.CONVEX_URL;
      else process.env.CONVEX_URL = previous;
    }
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n");
  });

  it("refuses a cloud URL and the configured CONVEX_URL before spawning", async () => {
    const request = {
      jsonDirectory: "/tmp/jarvis-lv1-restart-must-not-exist",
      liveDirectory: "/tmp/jarvis-lv1-restart-must-not-exist",
      clientId: "client",
      taskId: "task",
      buildId: "build",
      quoteId: "quote",
      configuredConvexUrl: "https://configured.example",
    };
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://happy-animal-123.convex.cloud",
        }),
      /refuses a Convex cloud URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://convex.cloud/api",
        }),
      /refuses a Convex cloud URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://configured.example",
        }),
      /refuses the configured CONVEX_URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          configuredConvexUrl: "https://configured.example/",
          isolatedConvexUrl: "https://configured.example",
        }),
      /refuses the configured CONVEX_URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://happy-animal-123.convex.cloud./",
        }),
      /refuses a Convex cloud URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://happy-animal-123.convex.site",
        }),
      /refuses a Convex cloud URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "https://happy-animal-123.convex.site./",
        }),
      /refuses a Convex cloud URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          configuredConvexUrl: "http://127.0.0.1:3210",
          isolatedConvexUrl: "http://localhost:3210",
        }),
      /refuses the configured CONVEX_URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          configuredConvexUrl: "http://localhost:3210",
          isolatedConvexUrl: "http://127.0.0.1:3210",
        }),
      /refuses the configured CONVEX_URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          configuredConvexUrl: "http://127.0.0.1:3210",
          isolatedConvexUrl: "http://[::1]:3210",
        }),
      /refuses the configured CONVEX_URL/,
    );
    await assert.rejects(
      () =>
        readRestartedProcess({
          ...request,
          isolatedConvexUrl: "http://127.0.0.1:3210",
        }),
      /requires JARVIS_DELIVERY_RUNTIME_TOKEN/,
    );
  });

  it("compares quote GET across two isolated processes when the delivery token is set", async () => {
    const deliveryToken = "local-v1-restart-delivery-token-0000";
    const quoteId = "quote-restart";
    const taskId = "task-restart";
    const buildId = "build-restart";
    const stub = http.createServer((req, response) => {
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
        const functionPath = body.path ?? "";
        let value: Value = null;
        if (functionPath === "tasks:list") {
          value = [
            {
              _id: taskId,
              title: "live-task",
              completed: false,
              category: "home",
              createdAt: 1,
            },
          ];
        } else if (functionPath === "builds:get") {
          value = {
            _id: buildId,
            name: "live-build",
            kind: "boat",
            status: "active",
            createdAt: 4,
            updatedAt: 5,
          };
        } else if (functionPath === "quotes:get") {
          value = {
            aggregate: {
              _id: "agg-restart",
              _creationTime: 1,
              quoteId,
              ownerId: "jarvis-cli",
              clientId: "client-1",
              number: "Q-RESTART",
              currentRevision: 1,
              currentRevisionId: "rev-1",
              aggregateVersion: 1,
              commercialStatus: "open",
              createdAt: 1,
              updatedAt: 1,
            },
            revision: {
              _id: "rev-restart",
              _creationTime: 1,
              revisionId: "rev-1",
              ownerId: "jarvis-cli",
              quoteId,
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
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub.address();
    if (address === null || typeof address === "string") {
      stub.close();
      throw new Error("Isolated Convex stub did not bind.");
    }
    const root = await tempDir();
    const live = path.join(root, "live");
    const jsonDirectory = path.join(root, "json");
    await fs.mkdir(live);
    await fs.mkdir(jsonDirectory);
    await fs.writeFile(path.join(live, "sentinel.txt"), "keep\n", "utf8");
    const clients = new JsonClientStore(path.join(jsonDirectory, "jarvis-clients.json"), () => {});
    const client = await clients.add({ name: "Ada", contacts: [] });
    try {
      const restarted = await readRestartedProcess({
        jsonDirectory,
        liveDirectory: live,
        clientId: client.id,
        taskId,
        buildId,
        quoteId,
        configuredConvexUrl: "https://configured.example",
        isolatedConvexUrl: `http://127.0.0.1:${address.port}`,
        deliveryRuntimeToken: deliveryToken,
      });
      assert.equal(restarted.quoteRecovered, true);
      assert.equal(restarted.first.quoteStatus, 200);
      assert.equal(restarted.second.quoteStatus, 200);
      assert.equal(restarted.first.quoteBody, restarted.second.quoteBody);
      assert.match(restarted.first.quoteBody, /Q-RESTART/);
      assert.match(restarted.first.clientBody, /Ada/);
      assert.match(restarted.first.taskBody, /live-task/);
      assert.match(restarted.first.buildBody, /live-build/);
      assert.equal(restarted.first.clientBody, restarted.second.clientBody);
      assert.equal(restarted.first.taskBody, restarted.second.taskBody);
      assert.equal(restarted.first.buildBody, restarted.second.buildBody);
      const visible = `${restarted.first.quoteBody}${restarted.first.clientBody}${restarted.first.taskBody}${restarted.first.buildBody}`;
      assert.equal(visible.includes(deliveryToken), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        stub.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
