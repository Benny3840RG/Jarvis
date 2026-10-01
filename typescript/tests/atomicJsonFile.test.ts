import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writePrivateJsonFile } from "../src/persistence/atomicJsonFile.js";

let dir: string;
const posixOnly = { skip: process.platform === "win32" };

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

  it("syncs the directory after file-sync and rename", posixOnly, async (t) => {
    const file = path.join(dir, "record.json");
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    const events: string[] = [];
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await originalRename(...args);
      events.push("rename");
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      if (args[0] === dir && args[1] === "r") {
        t.mock.method(handle, "sync", async () => {
          assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
          assert.deepEqual(events, ["file-sync", "rename"]);
          await originalSync();
          events.push("directory-sync");
        });
      } else {
        t.mock.method(handle, "sync", async () => {
          await originalSync();
          events.push("file-sync");
        });
      }
      return handle;
    });
    await writePrivateJsonFile(file, { ok: true });
    assert.deepEqual(events, ["file-sync", "rename", "directory-sync"]);
  });

  for (const code of ["EPERM", "EINVAL", "EISDIR", "EIO"]) {
    it(`propagates POSIX directory-open ${code}`, posixOnly, async (t) => {
      const file = path.join(dir, "record.json");
      const originalOpen = fs.open.bind(fs);
      const failure = Object.assign(new Error(`directory open ${code}`), { code });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === dir && args[1] === "r") throw failure;
        return originalOpen(...args);
      });
      await assert.rejects(writePrivateJsonFile(file, { replacement: true }), (error) => {
        assert.equal(error, failure);
        return true;
      });
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { replacement: true });
      assert.deepEqual(await readdir(dir), ["record.json"]);
    });
  }

  for (const code of ["EPERM", "EINVAL", "EISDIR", "EIO", "ENOSPC"]) {
    it(`propagates directory-sync ${code} and closes`, posixOnly, async (t) => {
      const file = path.join(dir, "record.json");
      const originalOpen = fs.open.bind(fs);
      const failure = Object.assign(new Error(`directory sync ${code}`), { code });
      let directoryClosed = false;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === dir && args[1] === "r") {
          const originalClose = handle.close.bind(handle);
          t.mock.method(handle, "sync", async () => {
            throw failure;
          });
          t.mock.method(handle, "close", async () => {
            await originalClose();
            directoryClosed = true;
          });
        }
        return handle;
      });
      await assert.rejects(writePrivateJsonFile(file, { replacement: true }), (error) => {
        assert.equal(error, failure);
        return true;
      });
      assert.equal(directoryClosed, true);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { replacement: true });
      assert.deepEqual(await readdir(dir), ["record.json"]);
    });
  }

  it("syncs new ancestor entries up to the existing parent", posixOnly, async (t) => {
    const first = path.join(dir, "new");
    const nested = path.join(first, "nested");
    const file = path.join(nested, "record.json");
    const originalOpen = fs.open.bind(fs);
    const syncedDirectories: string[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === "r") {
        const originalSync = handle.sync.bind(handle);
        t.mock.method(handle, "sync", async () => {
          await originalSync();
          syncedDirectories.push(String(args[0]));
        });
      }
      return handle;
    });
    await writePrivateJsonFile(file, { ok: true });
    assert.deepEqual(syncedDirectories, [nested, first, dir]);
  });

  for (const code of ["EPERM", "EINVAL", "EISDIR", "EIO"]) {
    it(`keeps the Windows directory-open fallback bounded for ${code}`, async (t) => {
      const file = path.join(dir, "record.json");
      const originalOpen = fs.open.bind(fs);
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      assert(descriptor);
      const failure = Object.assign(new Error(`directory open ${code}`), { code });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === dir && args[1] === "r") throw failure;
        return originalOpen(...args);
      });
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      try {
        const write = writePrivateJsonFile(file, { ok: true });
        if (code === "EIO") {
          await assert.rejects(write, (error) => error === failure);
        } else {
          await write;
        }
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
    });
  }

  it("resolves relative destinations before syncing ancestors", posixOnly, async (t) => {
    const directory = path.join(dir, "new");
    const file = path.join(directory, "record.json");
    const originalOpen = fs.open.bind(fs);
    const directories: string[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === "r") directories.push(String(args[0]));
      return originalOpen(...args);
    });
    await writePrivateJsonFile(path.relative(process.cwd(), file), { ok: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
    assert.deepEqual(directories, [directory, dir]);
  });

  it("cleans temp files without directory sync when rename fails", async (t) => {
    const target = path.join(dir, "record.json");
    await mkdir(target);
    const originalOpen = fs.open.bind(fs);
    let directoryOpened = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === dir && args[1] === "r") directoryOpened = true;
      return originalOpen(...args);
    });
    await assert.rejects(() => writePrivateJsonFile(target, { ok: true }));
    assert.equal(directoryOpened, false);
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });
});
