import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writePrivateJsonFile } from "../src/persistence/atomicJsonFile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-atomic-json-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withPermissiveUmask<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o000);
  try {
    return await operation();
  } finally {
    process.umask(previous);
  }
}

describe("writePrivateJsonFile", () => {
  it("writes private 0o600 JSON even when the process umask is 0", async () => {
    const file = path.join(dir, "nested", "record.json");
    await withPermissiveUmask(() => writePrivateJsonFile(file, { version: 1, items: ["a"] }));

    if (process.platform === "win32") return;
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(file, "utf8"),
      `{
  "version": 1,
  "items": [
    "a"
  ]
}
`,
    );
  });

  it("replaces an existing world-readable file with a private inode", async () => {
    const file = path.join(dir, "record.json");
    await writeFile(file, '{"stale":true}\n', { mode: 0o644 });
    await withPermissiveUmask(() => writePrivateJsonFile(file, { stale: false }));

    if (process.platform === "win32") return;
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /"stale": false/);
  });

  it("does not leave temp files when the final rename fails", async () => {
    const target = path.join(dir, "record.json");
    await mkdir(target);
    await assert.rejects(() => writePrivateJsonFile(target, { ok: true }));
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });
});
