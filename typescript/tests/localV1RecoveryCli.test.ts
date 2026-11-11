import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configFromEnvironment, writeRecoveryEvidence } from "../src/tools/runLocalV1Recovery.js";

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
    await assert.rejects(() => writeRecoveryEvidence(target, "replacement", config), /EEXIST/);
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
