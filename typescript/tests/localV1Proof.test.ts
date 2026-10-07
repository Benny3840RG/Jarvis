import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import {
  assertIsolatedReadsMatch,
  proveLocalV1Recovery,
  type IsolatedRead,
} from "../src/backup/v4/localV1Proof.js";
import { rereadIsolatedHttp } from "../src/backup/v4/localV1ProofHttp.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";
import type { QuoteRepository } from "../src/quotes/quoteRepository.js";
import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lv1-proof-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const readIds: IsolatedRead = {
  clientId: "client-1",
  taskId: "task-1",
  buildId: "build-1",
  quoteId: "quote-1",
};

describe("Local V1 proof gate", () => {
  it("refuses CONVEX_URL before any restore write and leaves the live directory unchanged", async () => {
    const root = await tempDir();
    const live = path.join(root, "live");
    const restored = path.join(root, "restored");
    await fs.mkdir(live);
    const liveFile = path.join(live, "jarvis-clients.json");
    await fs.writeFile(liveFile, '{"keep":true}\n', "utf8");
    const before = await fs.readFile(liveFile, "utf8");
    const calls: string[] = [];
    const previous = process.env.CONVEX_URL;
    process.env.CONVEX_URL = "https://live.example";
    try {
      await assert.rejects(
        () =>
          proveLocalV1Recovery({
            restore: {
              captureDirectory: path.join(root, "capture"),
              jsonDirectory: restored,
              client: {
                action: async () => {
                  calls.push("action");
                  throw new Error("restore action");
                },
              },
              serviceToken: "lv1-proof-service-token-000000000000",
              approvalToken: "lv1-proof-approval-token-00000000000",
              convexUrl: "https://live.example",
              now: 1,
              liveDataDir: live,
            },
            liveDirectory: live,
            readIsolated: async () => {
              calls.push("read");
              return readIds;
            },
          }),
        /refuses CONVEX_URL/,
      );
    } finally {
      if (previous === undefined) delete process.env.CONVEX_URL;
      else process.env.CONVEX_URL = previous;
    }
    assert.deepEqual(calls, []);
    await assert.rejects(
      () => fs.lstat(restored),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
    assert.equal(await fs.readFile(liveFile, "utf8"), before);
  });

  it("rejects an empty isolated read and a restart that does not match", () => {
    assert.throws(
      () => assertIsolatedReadsMatch({ ...readIds, clientId: "" }, readIds),
      /Local V1 proof read was empty/,
    );
    assert.throws(
      () => assertIsolatedReadsMatch(readIds, { ...readIds, quoteId: "quote-2" }),
      /restart did not match/,
    );
  });

  it("serves the same client, task, build, and quote GET from a second HTTP app", async () => {
    const dir = await tempDir();
    const clients = new JsonClientStore(path.join(dir, "jarvis-clients.json"), () => {});
    const persistence = new JSONPersistence(path.join(dir, "jarvis-state.json"), () => {});
    const builds = new JsonBuildStore(path.join(dir, "jarvis-builds.json"), () => {});
    const client = await clients.add({ name: "Ada", contacts: [] });
    const task = await persistence.addTask("live-task", "home");
    const build = await builds.add({ name: "live-build", kind: "tool" });
    const snapshot = {
      aggregate: {
        quoteId: "quote-1",
        ownerId: "jarvis-cli",
        clientId: client.id,
        number: "Q-1",
        currentRevision: 1,
        currentRevisionId: "rev-1",
        aggregateVersion: 1,
        commercialStatus: "open",
        createdAt: 1,
        updatedAt: 1,
      },
      revision: {
        revisionId: "rev-1",
        ownerId: "jarvis-cli",
        quoteId: "quote-1",
        revision: 1,
        revisionVersion: 1,
        status: "draft",
        lineItems: [{ description: "Work", quantity: 1, unitPrice: 1 }],
        subtotal: 1,
        tax: 0,
        total: 1,
        currency: "AUD",
        termsIncluded: false,
        createdAt: 1,
        updatedAt: 1,
      },
    } as QuoteSnapshot;
    const quoteRepository = {
      getQuote: async (quoteId: string) =>
        quoteId === snapshot.aggregate.quoteId ? snapshot : null,
    } as QuoteRepository;
    const ids = await rereadIsolatedHttp({
      persistence,
      clientStore: clients,
      buildStore: builds,
      quoteRepository,
      ids: {
        clientId: client.id,
        taskId: task.id,
        buildId: build.id,
        quoteId: snapshot.aggregate.quoteId,
      },
    });
    assert.equal(ids.clientId, client.id);
    assert.equal(ids.taskId, task.id);
    assert.equal(ids.buildId, build.id);
    assert.equal(ids.quoteId, "quote-1");
  });
});
