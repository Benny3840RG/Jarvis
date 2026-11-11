import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertRecoveryEvidencePath,
  configFromEnvironment,
  writeRecoveryEvidence,
} from "../src/tools/runLocalV1Recovery.js";

const environment = {
  JARVIS_LV1_ISOLATED_CONVEX_URL: "http://127.0.0.1:3210",
  JARVIS_DELIVERY_RUNTIME_TOKEN: "fixture-token",
  JARVIS_LV1_JSON_DIR: "/tmp/isolated-json",
  JARVIS_LV1_CLIENT_ID: "client",
  JARVIS_LV1_TASK_ID: "task",
  JARVIS_LV1_BUILD_ID: "build",
  JARVIS_LV1_QUOTE_ID: "quote",
};

test("live directory uses the environment loaded by the CLI", () => {
  assert.equal(
    configFromEnvironment({ ...environment, JARVIS_DATA_DIR: "/tmp/actual-live" }, "fixture")
      .liveDirectory,
    "/tmp/actual-live",
  );
  assert.equal(
    configFromEnvironment(
      { ...environment, JARVIS_DATA_DIR: "/tmp/actual-live", JARVIS_LV1_LIVE_DIR: " " },
      "fixture",
    ).liveDirectory,
    "/tmp/actual-live",
  );
});

test("evidence writes refuse protected trees, symlink aliases and existing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    const alias = path.join(root, "alias");
    await fs.symlink(live, alias);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    for (const target of [
      path.join(live, "new", "proof.md"),
      path.join(alias, "proof.md"),
      path.join(isolated, "proof.md"),
    ]) {
      await assert.rejects(
        () => writeRecoveryEvidence(target, "evidence", config),
        /protected data directory/,
      );
    }
    assert.deepEqual(await fs.readdir(live), []);
    assert.deepEqual(await fs.readdir(isolated), []);
    const target = path.join(root, "evidence", "proof.md");
    await writeRecoveryEvidence(target, "first", config);
    await assert.rejects(
      () => writeRecoveryEvidence(target, "replacement", config),
      /already exists; existing files are never replaced/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "first\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("evidence writes refuse dangling links into protected trees without a raw EEXIST", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-dangling-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const work = path.join(root, "work");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    await fs.mkdir(work);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const liveFile = path.join(work, "live-evidence.md");
    await fs.symlink(path.join(live, "planted.md"), liveFile);
    const isolatedFile = path.join(work, "isolated-evidence.md");
    await fs.symlink(path.join(isolated, "planted.md"), isolatedFile);
    const liveDirectoryLink = path.join(work, "live-directory");
    await fs.symlink(path.join(live, "planted"), liveDirectoryLink);
    for (const target of [liveFile, isolatedFile, path.join(liveDirectoryLink, "proof.md")]) {
      await assert.rejects(
        () => writeRecoveryEvidence(target, "evidence", config),
        (error: unknown) =>
          error instanceof Error &&
          /refuses a dangling symbolic link/.test(error.message) &&
          !/EEXIST|ENOENT|ENOTDIR/.test(error.message),
      );
    }
    assert.deepEqual(await fs.readdir(live), []);
    assert.deepEqual(await fs.readdir(isolated), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("replacing a newly created output parent with a live-data symlink cannot redirect evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-race-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const output = path.join(root, "evidence");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const originalMkdir = fs.mkdir;
    let replaced = false;
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await originalMkdir(...args);
      if (!replaced && path.basename(String(args[0])) === "evidence") {
        replaced = true;
        await fs.rename(output, path.join(root, "moved-evidence"));
        await fs.symlink(live, output);
      }
      return result;
    });
    await assert.rejects(() =>
      writeRecoveryEvidence(path.join(output, "proof.md"), "secret", config),
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(live), []);
    assert.deepEqual(await fs.readdir(isolated), []);
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("replacing an opened output parent with a live-data symlink fails closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-open-race-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const output = path.join(root, "evidence");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    await fs.mkdir(output);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const originalOpen = fs.open;
    let replaced = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (!replaced && path.basename(String(args[0])) === "evidence") {
        replaced = true;
        await fs.rename(output, path.join(root, "moved-evidence"));
        await fs.symlink(live, output);
      }
      return handle;
    });
    await assert.rejects(
      () => writeRecoveryEvidence(path.join(output, "proof.md"), "secret", config),
      /parent changed during creation/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(live), []);
    assert.deepEqual(await fs.readdir(isolated), []);
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("renaming the protected live inode into the evidence parent during traversal is refused", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-inode-race-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const output = path.join(root, "evidence");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const originalOpen = fs.open;
    let swapped = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (!swapped && args[0] === path.parse(output).root) {
        swapped = true;
        await fs.rename(live, output);
        await fs.mkdir(live);
      }
      return originalOpen(...args);
    });
    await assert.rejects(
      () => writeRecoveryEvidence(path.join(output, "proof.md"), "secret", config),
      /protected data directory/,
    );
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readdir(output), []);
    assert.deepEqual(await fs.readdir(live), []);
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("moving the opened output parent beneath live data leaves no evidence there", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-descendant-race-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const output = path.join(root, "evidence");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    await fs.mkdir(output);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    for (const moment of ["before-create", "after-create", "after-write"] as const) {
      const originalOpen = fs.open;
      let moved = false;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const name = path.basename(String(args[0]));
        const move = async (): Promise<void> => {
          moved = true;
          // The pinned handle now names a descendant of live data whose inode
          // differs from the protected root, and the old path is a real
          // directory again.
          await fs.rename(output, path.join(live, "nested"));
          await fs.mkdir(output);
        };
        if (!moved && moment === "before-create" && name === "evidence") {
          const handle = await originalOpen(...args);
          await move();
          return handle;
        }
        const handle = await originalOpen(...args);
        if (!moved && moment === "after-create" && name === "proof.md") await move();
        if (!moved && moment === "after-write" && name === "proof.md") {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs: Parameters<typeof write>) => {
            await write(...writeArgs);
            await move();
          };
        }
        return handle;
      });
      await assert.rejects(
        () => writeRecoveryEvidence(path.join(output, "proof.md"), "secret", config),
        /outside every protected data directory/,
        moment,
      );
      t.mock.restoreAll();
      assert.equal(moved, true, moment);
      assert.deepEqual(await fs.readdir(path.join(live, "nested")), [], moment);
      assert.deepEqual(await fs.readdir(output), [], moment);
      assert.deepEqual(await fs.readdir(isolated), [], moment);
      await fs.rename(path.join(live, "nested"), path.join(root, "spare"));
      await fs.rm(path.join(root, "spare"), { recursive: true });
    }
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed ancestor check closes the ancestor handle it opened", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-ancestor-leak-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    const output = path.join(root, "evidence");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    await fs.mkdir(output);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const originalOpen = fs.open;
    let closed: boolean | undefined;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (closed === undefined && String(args[0]).endsWith("/..")) {
        closed = false;
        handle.stat = (async () => {
          throw new Error("injected ancestor stat failure");
        }) as typeof handle.stat;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closed = true;
          await close();
        };
      }
      return handle;
    });
    await assert.rejects(
      () => writeRecoveryEvidence(path.join(output, "proof.md"), "secret", config),
      /injected ancestor stat failure/,
    );
    assert.equal(closed, true);
    assert.deepEqual(await fs.readdir(output), []);
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("evidence path problems are reported before the proof would run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-preflight-"));
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    await assert.rejects(
      () => assertRecoveryEvidencePath(path.join(live, "proof.md"), config),
      /protected data directory/,
    );
    const existing = path.join(root, "existing.md");
    await fs.writeFile(existing, "earlier run\n");
    await assert.rejects(
      () => assertRecoveryEvidencePath(existing, config),
      /already exists; existing files are never replaced/,
    );
    assert.equal(await fs.readFile(existing, "utf8"), "earlier run\n");
    const fresh = path.join(root, "new", "proof.md");
    assert.equal(
      await assertRecoveryEvidencePath(fresh, config),
      path.join(await fs.realpath(root), "new", "proof.md"),
    );
    assert.deepEqual((await fs.readdir(root)).sort(), ["existing.md", "isolated", "live"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("evidence is written beneath a search-only ancestor directory", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-evidence-search-only-"));
  const gate = path.join(root, "gate");
  try {
    const live = path.join(root, "live");
    const isolated = path.join(root, "isolated");
    await fs.mkdir(live);
    await fs.mkdir(isolated);
    await fs.mkdir(path.join(gate, "out"), { recursive: true });
    await fs.chmod(gate, 0o300);
    const config = {
      ...configFromEnvironment(environment, "fixture"),
      liveDirectory: live,
      jsonDirectory: isolated,
    };
    const target = path.join(gate, "out", "proof.md");
    await writeRecoveryEvidence(target, "evidence", config);
    assert.equal(await fs.readFile(target, "utf8"), "evidence\n");
  } finally {
    await fs.chmod(gate, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
