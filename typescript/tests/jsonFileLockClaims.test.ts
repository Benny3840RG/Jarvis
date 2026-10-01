import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";

import { JsonFileLock } from "../src/persistence/jsonFileLock.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lock-claims-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const lockPath = `${file}.lock`;
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert(pid);
  await once(child, "exit");
  const record = { pid, acquiredAt: 1, token: "old-lock" };
  await fs.writeFile(lockPath, JSON.stringify(record), { mode: 0o600 });
  const identity = createHash("sha256").update("valid\0old-lock").digest("hex");
  const claimPath = `${lockPath}.reclaim-${identity}-0`;
  return { dir, file, lockPath, claimPath, record };
}

it("a paused claim writer cannot steal a successor's live lock", { timeout: 10_000 }, async (t) => {
  const { file, lockPath } = await fixture(t);
  const partialOpened = gate();
  const resumeClaimWrite = gate();
  const beforeDeletes = [gate(), gate()];
  const allowDeletes = [gate(), gate()];
  const entered = [gate(), gate()];
  const leave = [gate(), gate()];
  const originalOpen = fs.open.bind(fs);
  const originalRm = fs.rm.bind(fs);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let partialInjected = false;
  let deletes = 0;
  let active = 0;
  let maxActive = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (!partialInjected && String(args[0]).includes(".reclaim-")) {
      partialInjected = true;
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof write>) => {
        partialOpened.release();
        await resumeClaimWrite.promise;
        return write(...writeArgs);
      });
    }
    return handle;
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === lockPath && deletes < 2) {
      const index = deletes++;
      beforeDeletes[index].release();
      await allowDeletes[index].promise;
    }
    return originalRm(...args);
  });
  const operate = (index: number) =>
    new JsonFileLock(file, () => undefined, 1_000).run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered[index].release();
      await leave[index].promise;
      active -= 1;
    });
  const runs: Promise<void>[] = [];
  try {
    const first = operate(0);
    runs.push(first);
    void first.catch(() => undefined);
    await partialOpened.promise;
    // A living process can be suspended after create and before its write.
    clock += 10_000;
    const second = operate(1);
    runs.push(second);
    void second.catch(() => undefined);
    await beforeDeletes[0].promise;
    resumeClaimWrite.release();
    const outcome = await Promise.race([
      beforeDeletes[1].promise.then(() => "second-unlink"),
      first.then(() => "completed").catch(() => "refused"),
    ]);
    allowDeletes[0].release();
    await entered[1].promise;
    if (outcome === "second-unlink") {
      allowDeletes[1].release();
      await entered[0].promise;
    }
    assert.equal(maxActive, 1, "a delayed claimant removed its successor's live lock");
    assert.equal(deletes, 1, "only the elected claimant may unlink the stale generation");
  } finally {
    resumeClaimWrite.release();
    for (const item of allowDeletes) item.release();
    for (const item of leave) item.release();
    await Promise.allSettled(runs);
  }
});

it("does not infer a dead owner from an aged malformed reclaim claim", async (t) => {
  const { file, lockPath, claimPath, record } = await fixture(t);
  await fs.writeFile(claimPath, "{", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(claimPath, old, old);
  let entered = false;
  await assert.rejects(
    new JsonFileLock(file, () => undefined, 250).run(async () => {
      entered = true;
    }),
    /JSON state is locked/,
  );
  assert.equal(entered, false);
  assert.equal(await fs.readFile(claimPath, "utf8"), "{");
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), record);
});

it("retains election ownership when removing the stale lock fails", async (t) => {
  const { file, lockPath, claimPath, record } = await fixture(t);
  const originalRm = fs.rm.bind(fs);
  const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === lockPath) throw failure;
    return originalRm(...args);
  });
  let entered = false;
  await assert.rejects(
    new JsonFileLock(file, () => undefined, 1_000).run(async () => {
      entered = true;
    }),
    (error) => error === failure,
  );
  assert.equal(entered, false);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), record);
  const claim = JSON.parse(await fs.readFile(claimPath, "utf8")) as { pid: number };
  assert.equal(claim.pid, process.pid);
});

it("recovers a complete claim whose owning process has exited", async (t) => {
  const { file, lockPath, claimPath, record } = await fixture(t);
  await fs.writeFile(claimPath, JSON.stringify({ ...record, token: "dead-claim" }));
  const result = await new JsonFileLock(file, () => undefined, 1_000).run(async () => "saved");
  assert.equal(result, "saved");
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});

it("cleans only its private temporary claim after a publication write failure", async (t) => {
  const { dir, file, lockPath, record } = await fixture(t);
  const originalOpen = fs.open.bind(fs);
  const failure = Object.assign(new Error("claim write failed"), { code: "EIO" });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes(".reclaim-")) {
      t.mock.method(handle, "writeFile", async () => {
        throw failure;
      });
    }
    return handle;
  });
  await assert.rejects(
    new JsonFileLock(file, () => undefined, 1_000).run(async () => "never"),
    (error) => error === failure,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), record);
  assert.deepEqual(await fs.readdir(dir), [path.basename(lockPath)]);
});
