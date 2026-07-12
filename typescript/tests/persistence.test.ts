import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ConvexPersistence,
  JSONPersistence,
  assistantStateFunctions,
  createPersistenceFromEnv,
  type AssistantState,
  type ConvexClientLike,
} from "../src/persistence/persistence.js";

const originalProvider = process.env.PERSISTENCE_PROVIDER;
const originalUrl = process.env.CONVEX_URL;
let tempDir = "";

beforeEach(async () => {
  delete process.env.PERSISTENCE_PROVIDER;
  delete process.env.CONVEX_URL;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-persistence-"));
});

afterEach(async () => {
  if (originalProvider === undefined) delete process.env.PERSISTENCE_PROVIDER;
  else process.env.PERSISTENCE_PROVIDER = originalProvider;
  if (originalUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalUrl;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("JSONPersistence", () => {
  it("returns empty state when file is missing", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "missing.json"));
    assert.deepEqual(await provider.loadState(), {});
  });

  it("saves and reloads state", async () => {
    const file = path.join(tempDir, "state.json");
    const provider = new JSONPersistence(file);
    const sample = { lastIntent: "testing", lastInput: "hi" };
    await provider.saveState(sample);
    assert.deepEqual(await provider.loadState(), sample);
  });

  it("reports malformed JSON", async () => {
    const file = path.join(tempDir, "bad.json");
    await fs.writeFile(file, "{not json", "utf8");
    await assert.rejects(new JSONPersistence(file).loadState(), /Malformed JSON/);
  });
});

describe("createPersistenceFromEnv", () => {
  it("defaults to JSON", () => {
    assert(createPersistenceFromEnv() instanceof JSONPersistence);
  });

  it("selects Convex with an injected client and no real URL", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    const mock: ConvexClientLike = {
      async query<T>() {
        return null as T;
      },
      async mutation<T>() {
        return undefined as T;
      },
    };
    assert(createPersistenceFromEnv(mock) instanceof ConvexPersistence);
  });

  it("fails fast when Convex is selected without a URL or client", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert.throws(() => createPersistenceFromEnv(), /CONVEX_URL/);
  });

  it("rejects unknown provider names", () => {
    process.env.PERSISTENCE_PROVIDER = "sqlite";
    assert.throws(() => createPersistenceFromEnv(), /Invalid PERSISTENCE_PROVIDER/);
  });
});

describe("ConvexPersistence", () => {
  it("loads assistant state using the expected function reference", async () => {
    const sample: AssistantState = { lastIntent: "hello" };
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown, args?: Record<string, never>) {
        assert.equal(reference, assistantStateFunctions.get);
        assert.deepEqual(args, {});
        return { state: sample } as T;
      },
      async mutation<T>() {
        return undefined as T;
      },
    };

    assert.deepEqual(await new ConvexPersistence(mock).loadState(), sample);
  });

  it("saves assistant state using the wrapped payload", async () => {
    const sample: AssistantState = { lastIntent: "save-test" };
    let seen: Record<string, unknown> | undefined;
    const mock: ConvexClientLike = {
      async query<T>() {
        return null as T;
      },
      async mutation<T>(reference: unknown, args: Record<string, unknown>) {
        assert.equal(reference, assistantStateFunctions.upsert);
        seen = args;
        return undefined as T;
      },
    };

    await new ConvexPersistence(mock).saveState(sample);
    assert.deepEqual(seen, { state: sample });
  });
});
