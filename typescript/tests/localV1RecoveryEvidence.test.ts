import assert from "node:assert/strict";
import { test } from "node:test";

import {
  localV1RestartProofPassed,
  renderLocalV1RestartProofEvidence,
  type LocalV1RestartProofRecord,
  type LocalV1RestartProofConfig,
} from "../src/backup/v4/localV1RecoveryDriver.js";

const passing: LocalV1RestartProofRecord = {
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  isolatedEndpoint: "127.0.0.1:3210",
  configuredUrlRefused: true,
  quoteRecovered: true,
  quoteBodySha256: "a".repeat(64),
  clientMatched: true,
  taskMatched: true,
  buildMatched: true,
  liveDirectoryUnchanged: true,
};

test("a failed configured-URL refusal cannot pass the restart proof", () => {
  const record = { ...passing, configuredUrlRefused: false };
  assert.match(renderLocalV1RestartProofEvidence(record), /refused as target \| FAIL/);
  assert.equal(localV1RestartProofPassed(record), false);
});

test("every mandatory recorded failure rejects the restart proof", () => {
  for (const field of [
    "quoteRecovered",
    "clientMatched",
    "taskMatched",
    "buildMatched",
    "liveDirectoryUnchanged",
  ] as const) {
    assert.equal(localV1RestartProofPassed({ ...passing, [field]: false }), false, field);
  }
  assert.equal(localV1RestartProofPassed(passing), true);
});

test("an absent optional configured URL is explicitly not applicable", () => {
  const record = { ...passing, configuredUrlRefused: null };
  assert.match(renderLocalV1RestartProofEvidence(record), /refused as target \| N\/A/);
  assert.equal(localV1RestartProofPassed(record), true);
  assert.doesNotMatch(renderLocalV1RestartProofEvidence(record), /\| FAIL/);
});

test("driver records absent configured URL as N/A without claiming a refusal", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-proof-record-"));
  try {
    await fs.mkdir(path.join(root, "isolated"));
    await fs.mkdir(path.join(root, "live"));
    const body = {
      clientBody: "client",
      taskBody: "task",
      buildBody: "build",
      quoteStatus: 200,
      quoteBody: "quote",
    };
    let calls = 0;
    const record = await runLocalV1RestartProof(
      {
        isolatedConvexUrl: "http://127.0.0.1:3210",
        configuredConvexUrl: undefined,
        deliveryRuntimeToken: "fixture-only",
        jsonDirectory: path.join(root, "isolated"),
        liveDirectory: path.join(root, "live"),
        ids: { clientId: "client", taskId: "task", buildId: "build", quoteId: "quote" },
        sourceSha: passing.sourceSha,
      },
      {
        restartRunner: async () => {
          calls += 1;
          return { first: body, second: body, quoteRecovered: true };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(record.configuredUrlRefused, null);
    assert.equal(localV1RestartProofPassed(record), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function driverFixture() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-review-"));
  const config: LocalV1RestartProofConfig = {
    isolatedConvexUrl: "http://127.0.0.1:3210",
    configuredConvexUrl: undefined,
    deliveryRuntimeToken: "fixture-only",
    jsonDirectory: path.join(root, "isolated"),
    liveDirectory: path.join(root, "live"),
    ids: { clientId: "client", taskId: "task", buildId: "build", quoteId: "quote" },
    sourceSha: passing.sourceSha,
  };
  await fs.mkdir(config.liveDirectory);
  await fs.mkdir(config.jsonDirectory);
  const body = {
    clientBody: "client",
    taskBody: "task",
    buildBody: "build",
    quoteStatus: 200,
    quoteBody: "quote",
  };
  return {
    config,
    root,
    result: { first: body, second: body, quoteRecovered: true },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("loopback gate rejects 127-prefixed DNS names before invoking the runner", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    for (const host of ["127.evil.example", "127.0.0.1.evil.example"]) {
      let calls = 0;
      await assert.rejects(
        () =>
          runLocalV1RestartProof(
            { ...fixture.config, isolatedConvexUrl: `http://${host}:3210` },
            {
              restartRunner: async () => {
                calls += 1;
                return fixture.result;
              },
            },
          ),
        /not a loopback host/,
      );
      assert.equal(calls, 0, "no fixture delivery token reaches a runner");
    }
    for (const host of ["127.0.0.1", "127.12.34.56", "localhost", "[::1]"]) {
      const record = await runLocalV1RestartProof(
        { ...fixture.config, isolatedConvexUrl: `http://${host}:3210` },
        { restartRunner: async () => fixture.result },
      );
      assert.equal(localV1RestartProofPassed(record), true, host);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("numeric mapped loopback reaches the runner and records bracketed IPv6 evidence", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    let calls = 0;
    const record = await runLocalV1RestartProof(
      { ...fixture.config, isolatedConvexUrl: "http://[::ffff:127.0.0.1]:3210" },
      {
        restartRunner: async () => {
          calls += 1;
          return fixture.result;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(record.isolatedEndpoint, "[::ffff:7f00:1]:3210");
    assert.match(
      renderLocalV1RestartProofEvidence(record),
      /Isolated backend: `\[::ffff:7f00:1\]:3210`/,
    );
    assert.equal(localV1RestartProofPassed(record), true);
  } finally {
    await fixture.cleanup();
  }
});

test("IPv6 endpoint evidence keeps brackets", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    const record = await runLocalV1RestartProof(
      { ...fixture.config, isolatedConvexUrl: "http://[::1]:3210" },
      { restartRunner: async () => fixture.result },
    );
    assert.equal(record.isolatedEndpoint, "[::1]:3210");
  } finally {
    await fixture.cleanup();
  }
});

test("mapped non-loopback IPv6 is refused before invoking the runner", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...fixture.config, isolatedConvexUrl: "http://[::ffff:192.0.2.1]:3210" },
          {
            restartRunner: async () => {
              calls += 1;
              return fixture.result;
            },
          },
        ),
      /not a loopback host/,
    );
    assert.equal(calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("mapped loopback still refuses a same-port configured alias before invoking the runner", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          {
            ...fixture.config,
            isolatedConvexUrl: "http://[::ffff:127.0.0.1]:3210",
            configuredConvexUrl: "http://127.0.0.1:3210",
          },
          {
            restartRunner: async () => {
              calls += 1;
              return fixture.result;
            },
          },
        ),
      /refuses the configured CONVEX_URL/,
    );
    assert.equal(calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("driver rejects a quote that changes across the restart even when the runner reports recovery", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    await assert.rejects(
      () =>
        runLocalV1RestartProof(fixture.config, {
          restartRunner: async () => ({
            ...fixture.result,
            second: { ...fixture.result.second, quoteBody: "a different quote" },
          }),
        }),
      /different quote after the restart/,
    );
    const record = await runLocalV1RestartProof(fixture.config, {
      restartRunner: async () => fixture.result,
    });
    assert.equal(localV1RestartProofPassed(record), true);
  } finally {
    await fixture.cleanup();
  }
});

test("driver names an unparseable configured CONVEX_URL instead of a raw TypeError", async () => {
  const { runLocalV1RestartProof, LocalV1RecoveryDriverError } =
    await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...fixture.config, configuredConvexUrl: "not a url" },
          {
            restartRunner: async () => {
              calls += 1;
              return fixture.result;
            },
          },
        ),
      (error: unknown) =>
        error instanceof LocalV1RecoveryDriverError &&
        /could not parse the configured CONVEX_URL/.test(error.message),
    );
    assert.equal(calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a failed live-directory re-check keeps the original runner failure as the cause", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const fs = await import("node:fs/promises");
  const { runLocalV1RestartProof, LocalV1RecoveryDriverError } =
    await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    await assert.rejects(
      () =>
        runLocalV1RestartProof(fixture.config, {
          restartRunner: async () => {
            await fs.chmod(fixture.config.liveDirectory, 0o000);
            throw new Error("isolated backend unreachable");
          },
        }),
      (error: unknown) =>
        error instanceof LocalV1RecoveryDriverError &&
        /could not re-check the live data directory/.test(error.message) &&
        error.cause instanceof Error &&
        error.cause.message === "isolated backend unreachable",
    );
  } finally {
    await fs.chmod(fixture.config.liveDirectory, 0o700).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("driver refuses dangling JSON-directory links into live data before any runner call", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { canonicalRecoveryPath, runLocalV1RestartProof } =
    await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    const live = fixture.config.liveDirectory;
    const finalLink = path.join(fixture.root, "dangling-json");
    await fs.symlink(path.join(live, "restored"), finalLink);
    const relativeLink = path.join(fixture.root, "dangling-relative");
    await fs.symlink(path.join("live", "restored"), relativeLink);
    for (const jsonDirectory of [
      finalLink,
      relativeLink,
      // A dangling intermediate component must be refused the same way.
      path.join(finalLink, "nested", "json"),
    ]) {
      let calls = 0;
      await assert.rejects(
        () =>
          runLocalV1RestartProof(
            { ...fixture.config, jsonDirectory },
            {
              restartRunner: async () => {
                calls += 1;
                return fixture.result;
              },
            },
          ),
        /refuses a dangling symbolic link/,
      );
      assert.equal(calls, 0);
    }
    assert.deepEqual(await fs.readdir(live), [], "nothing is created through the link");

    // A genuinely missing final directory still canonicalises through its
    // existing ancestors.
    const realRoot = await fs.realpath(fixture.root);
    assert.equal(
      await canonicalRecoveryPath(path.join(fixture.root, "missing", "json")),
      path.join(realRoot, "missing", "json"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("driver refuses equal, nested and symlink-aliased JSON/live roots before any runner call", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  try {
    const alias = path.join(fixture.root, "live-alias");
    await fs.symlink(fixture.config.liveDirectory, alias);
    for (const jsonDirectory of [
      fixture.config.liveDirectory,
      alias,
      path.join(fixture.config.liveDirectory, "child"),
      fixture.root,
    ]) {
      let calls = 0;
      await assert.rejects(
        () =>
          runLocalV1RestartProof(
            { ...fixture.config, jsonDirectory },
            {
              restartRunner: async () => {
                calls += 1;
                return fixture.result;
              },
            },
          ),
        /overlaps live data/,
      );
      assert.equal(calls, 0);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("runner paths stay pinned when live and JSON directory names are swapped", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  const originalLive = path.join(fixture.root, "original-live");
  const originalJson = path.join(fixture.root, "original-json");
  try {
    await fs.writeFile(path.join(fixture.config.liveDirectory, "sentinel"), "live");
    await assert.rejects(
      () =>
        runLocalV1RestartProof(fixture.config, {
          restartRunner: async (request) => {
            assert.equal(
              await fs.readFile(path.join(request.liveDirectory, "sentinel"), "utf8"),
              "live",
            );
            await fs.rename(fixture.config.liveDirectory, originalLive);
            await fs.rename(fixture.config.jsonDirectory, originalJson);
            await fs.mkdir(fixture.config.liveDirectory);
            await fs.symlink(fixture.config.liveDirectory, fixture.config.jsonDirectory);
            await fs.writeFile(path.join(request.jsonDirectory, "runner-marker"), "isolated");
            assert.equal(
              await fs.readFile(path.join(request.liveDirectory, "sentinel"), "utf8"),
              "live",
            );
            return fixture.result;
          },
        }),
      /directory path changed during the restart proof/,
    );
    assert.equal(await fs.readFile(path.join(originalJson, "runner-marker"), "utf8"), "isolated");
    await assert.rejects(() => fs.stat(path.join(originalLive, "runner-marker")), /ENOENT/);
    await assert.rejects(
      () => fs.stat(path.join(fixture.config.liveDirectory, "runner-marker")),
      /ENOENT/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("driver pins the canonical JSON inode if its requested alias is replaced before open", async (t) => {
  const { default: fs } = await import("node:fs/promises");
  const path = await import("node:path");
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const fixture = await driverFixture();
  const alias = path.join(fixture.root, "json-alias");
  const unrelated = path.join(fixture.root, "unrelated");
  try {
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(fixture.config.jsonDirectory, "intended"), "isolated");
    await fs.writeFile(path.join(unrelated, "wrong"), "unrelated");
    await fs.symlink(fixture.config.jsonDirectory, alias);
    const originalRealpath = fs.realpath;
    let swapped = false;
    t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await originalRealpath(...args);
      if (!swapped && args[0] === alias) {
        swapped = true;
        await fs.unlink(alias);
        await fs.symlink(unrelated, alias);
      }
      return resolved;
    });
    let calls = 0;
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...fixture.config, jsonDirectory: alias },
          {
            restartRunner: async () => {
              calls += 1;
              return fixture.result;
            },
          },
        ),
      /directory path changed during the restart proof/,
    );
    assert.equal(swapped, true);
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(unrelated), ["wrong"]);
  } finally {
    t.mock.restoreAll();
    await fixture.cleanup();
  }
});

test("configured cloud rejection is accepted only for the configured-target probe", async () => {
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const { readRestartedProcess } = await import("../src/backup/v4/localV1ProcessRestart.js");
  const fixture = await driverFixture();
  try {
    for (const domain of ["convex.cloud", "convex.site"]) {
      const configured = `https://fixture.${domain}`;
      let isolatedCalls = 0;
      const record = await runLocalV1RestartProof(
        { ...fixture.config, configuredConvexUrl: configured },
        {
          restartRunner: async (request) => {
            if (request.isolatedConvexUrl === configured) return readRestartedProcess(request);
            assert.equal(request.isolatedConvexUrl, fixture.config.isolatedConvexUrl);
            isolatedCalls += 1;
            return fixture.result;
          },
        },
      );
      assert.equal(record.configuredUrlRefused, true);
      assert.equal(isolatedCalls, 1);
      assert.equal(localV1RestartProofPassed(record), true);
    }
    await assert.rejects(
      () =>
        runLocalV1RestartProof(
          { ...fixture.config, configuredConvexUrl: "https://configured.example" },
          {
            restartRunner: async () => {
              throw new Error("unexpected fixture failure");
            },
          },
        ),
      /could not confirm/,
    );
  } finally {
    await fixture.cleanup();
  }
});
