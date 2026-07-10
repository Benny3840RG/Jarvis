import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";

import { JSONPersistence, ConvexPersistence, createPersistenceFromEnv } from "../src/persistence/persistence.js";
import * as assistantFns from "../convex/assistantState.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = path.resolve(path.dirname(__filename), "../data");
const TEST_FILE = path.join(FIXTURE_DIR, "test-state.json");

describe("JSONPersistence", () => {
  beforeEach(async () => {
    try {
      await fs.unlink(TEST_FILE);
    } catch {}
  });

  it("loads empty when file missing", async () => {
    const p = new JSONPersistence(TEST_FILE);
    const state = await p.loadState();
    assert.deepEqual(state, {});
  });

  it("saves and loads state", async () => {
    const p = new JSONPersistence(TEST_FILE);
    const sample = { lastIntent: "test", lastInput: "hi" };
    await p.saveState(sample);
    const loaded = await p.loadState();
    assert.equal(loaded.lastIntent, "test");
    assert.equal(loaded.lastInput, "hi");
  });

  it("throws on malformed JSON", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(TEST_FILE, "{ invalid json", "utf8");
    const p = new JSONPersistence(TEST_FILE);
    let caught = null;
    try {
      await p.loadState();
    } catch (err: any) {
      caught = err;
    }
    assert(caught instanceof Error);
    assert(caught.message.includes("Malformed JSON"));
  });
});

describe("createPersistenceFromEnv", () => {
  beforeEach(() => {
    delete process.env.PERSISTENCE_PROVIDER;
    delete process.env.CONVEX_URL;
  });

  it("defaults to JSON", () => {
    const p = createPersistenceFromEnv();
    assert(p instanceof JSONPersistence);
  });

  it("selects Convex and fails fast when CONVEX_URL missing", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    let caught = null;
    try {
      createPersistenceFromEnv();
    } catch (err: any) {
      caught = err;
    }
    assert(caught instanceof Error);
    assert(caught.message.includes("CONVEX_URL"));
  });
});

describe("ConvexPersistence (mock client)", () => {
  it("loadState calls assistantState/get and maps state", async () => {
    const sampleState = { lastIntent: "hello" };
    const mockClient = {
      query: async (name: string) => {
        assert.equal(name, "assistantState/get");
        return { id: "1", state: sampleState };
      },
      mutation: async (name: string, payload: any) => {
        // not used in this test
        return { id: "1" };
      },
    };

    const p = new ConvexPersistence(mockClient);
    const s = await p.loadState();
    assert.equal((s as any).lastIntent, "hello");
  });

  it("saveState calls assistantState/upsert with payload", async () => {
    let seenPayload: any = null;
    const mockClient = {
      query: async (name: string) => null,
      mutation: async (name: string, payload: any) => {
        assert.equal(name, "assistantState/upsert");
        seenPayload = payload;
        return { id: "42" };
      },
    };
    const p = new ConvexPersistence(mockClient);
    const sample = { lastIntent: "save-test" };
    await p.saveState(sample);
    assert.equal((seenPayload as any).lastIntent, "save-test");
  });
});

