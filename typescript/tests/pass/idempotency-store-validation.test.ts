import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { IdempotencyStore } from "../../src/preview/temporalPass/idempotency/idempotencyStore.js";

const directories: string[] = [];

async function storeFile(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "temporal-pass-store-"));
  directories.push(directory);
  const file = path.join(directory, "idempotency.json");
  await fs.writeFile(file, contents, { mode: 0o600 });
  return file;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Temporal PASS idempotency store validation", () => {
  it("rejects valid JSON with the wrong root shape instead of treating it as a store", async () => {
    for (const contents of ["[]", "null", '"text"']) {
      const store = new IdempotencyStore(await storeFile(contents));
      await assert.rejects(() => store.get("effect"), /corrupted|root must be an object/);
    }
  });

  it("rejects malformed entry shapes that could erase idempotency on rewrite", async () => {
    const invalid = JSON.stringify({
      effect: {
        operation: "merge",
        state: "completed",
        createdAt: "not-a-timestamp",
      },
    });
    const store = new IdempotencyStore(await storeFile(invalid));
    await assert.rejects(() => store.get("effect"), /corrupted|invalid idempotency entry/);
  });

  it("accepts a valid persisted entry", async () => {
    const createdAt = new Date().toISOString();
    const file = await storeFile(
      JSON.stringify({
        effect: {
          operation: "merge",
          state: "completed",
          result: { ok: true },
          createdAt,
          completedAt: createdAt,
        },
      }),
    );
    const store = new IdempotencyStore(file);
    assert.deepEqual(await store.get("effect"), {
      operation: "merge",
      state: "completed",
      result: { ok: true },
      createdAt,
      completedAt: createdAt,
    });
  });
});
