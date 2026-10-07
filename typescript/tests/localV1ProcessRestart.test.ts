import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

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
  });
});
