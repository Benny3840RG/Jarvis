import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import path from "node:path";
import fs from "node:fs/promises";

import {
  JSONPersistence,
  ConvexPersistence,
  createPersistenceFromEnv,
} from "../src/persistence/persistence.js";

const DATA_PATH = path.resolve(__dirname, "../data/test-jr-state.json");

describe("persistence abstraction", () => {
  beforeEach(async () => {
    try {
      await fs.unlink(DATA_PATH);
    } catch {}
  });

  it("defaults to JSON persistence when env is unset", () => {
    delete process.env.PERSISTENCE_PROVIDER;
    const provider = createPersistenceFromEnv();
    assert(provider instanceof JSONPersistence);
  });

  it("JSONPersistence loads and saves state", async () => {
    const provider = new JSONPersistence(DATA_PATH);
    const sample = { lastIntent: "testing", lastInput: "hi" };
    await provider.saveState(sample);
    const loaded = await provider.loadState();
    assert.equal(loaded.lastIntent, "testing");
    assert.equal(loaded.lastInput, "hi");
  });

  it("selects ConvexPersistence when env is convex", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    const provider = createPersistenceFromEnv();
    assert(provider instanceof ConvexPersistence);
  });
});
