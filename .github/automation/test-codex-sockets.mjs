// Secret-free Linux integration test. Never touches host service sockets.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchCodexBundle } from "./patch-codex-sockets.mjs";
import { socketPipeline } from "./codex-socket-test-harness.mjs";

assert.equal(process.getuid(), 0, "Run the disposable Linux fixture as root");
assert.equal(process.platform, "linux");
assert.ok(process.argv[2], "Pass the pinned upstream bundle");
const bundle = fs.readFileSync(process.argv[2], "utf8");
const patched = patchCodexBundle(bundle);
const execStart = bundle.indexOf(
  "async function execCommand(command, args, options = {})",
);
const execEnd = bundle.indexOf(
  "\n\n// src/checkActorPermissions.ts",
  execStart,
);
assert.ok(execStart > 0 && execEnd > execStart);
const execCommand = new Function(
  "import_node_child_process",
  "return (" + bundle.slice(execStart, execEnd) + ");",
)(childProcess);
function restriction(source) {
  const start = source.indexOf("async function restrictRootServiceSocket(");
  const end = source.indexOf(
    "\nasync function verifyPrivilegedSocketsRestricted(",
    start,
  );
  assert.ok(start > 0 && end > start);
  return new Function(
    "import_node_fs",
    "LINUX_O_PATH",
    "execCommand",
    "return (" + source.slice(start, end) + ");",
  )(fs, 0o10000000, execCommand);
}
const original = restriction(bundle);
const repaired = restriction(patched);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-socket-test-"));
fs.chmodSync(directory, 0o755);
const socketPath = path.join(directory, "service.sock");
const server = net.createServer((socket) => socket.end());
function descriptor(file = socketPath) {
  const stats = fs.statSync(file);
  return { path: file, device: stats.dev, inode: stats.ino };
}
function writableAs(uid) {
  const result = childProcess.spawnSync(
    "/usr/bin/setpriv",
    [
      "--reuid=" + uid,
      "--regid=65534",
      "--clear-groups",
      "--no-new-privs",
      "--",
      "/usr/bin/test",
      "-w",
      socketPath,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.equal(result.stderr, "");
  return result.status === 0;
}
function acl() {
  const result = childProcess.spawnSync(
    "/usr/bin/getfacl",
    ["-cpnE", "--", socketPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean);
}

function command(program, args) {
  const result = childProcess.spawnSync(program, args, {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

async function verifyPipeline() {
  const credentials = {
    userId: 65534,
    primaryGroupId: 65533,
    supplementaryGroupIds: [65532],
    fallbackGroupId: 65531,
  };
  const groups = new Set([65533, 65532, 65531]);
  const pipeline = socketPipeline(patched, directory);
  // #465 combined the original discovery/verifier with the repaired restriction.
  const previous = socketPipeline(patched, directory, {
    discoverySource: bundle,
  });
  // Hosted-runner checkout parents may be private to the runner UID. Give the
  // disposable test identities only these secret-free fixture files, without
  // changing checkout/home permissions or relying on their traversability.
  const fixtureHarness = path.join(directory, "harness.mjs");
  const fixtureBundle = path.join(directory, "patched-bundle.js");
  fs.writeFileSync(
    fixtureHarness,
    fs.readFileSync(
      new URL("./codex-socket-test-harness.mjs", import.meta.url),
    ),
    { mode: 0o644 },
  );
  fs.writeFileSync(fixtureBundle, patched, { mode: 0o644 });
  const childScript = `
    import fs from 'node:fs';
    import { socketPipeline } from ${JSON.stringify(pathToFileURL(fixtureHarness).href)};
    const source = fs.readFileSync(process.argv[1], 'utf8');
    try { await socketPipeline(source, process.argv[2]).verifyPrivilegedSocketsRestricted(); }
    catch (error) {
      if (!error.message.startsWith('drop-sudo did not revoke access')) throw error;
      process.exitCode = 81;
    }
  `;
  const unprivileged = (gid, supplementary = []) => {
    const result = childProcess.spawnSync(
      "/usr/bin/setpriv",
      [
        "--reuid=65534",
        "--regid=" + gid,
        supplementary.length
          ? "--groups=" + supplementary.join(",")
          : "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        childScript,
        fixtureBundle,
        directory,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.ok([0, 81].includes(result.status), result.stderr);
    return result.status;
  };
  for (const scenario of [
    "world",
    "supplementary-group",
    "named-acl",
    "fallback-group",
  ]) {
    command("/usr/bin/setfacl", ["-b", "--", socketPath]);
    fs.chownSync(
      socketPath,
      0,
      scenario === "supplementary-group"
        ? 65532
        : scenario === "fallback-group"
          ? 65531
          : 0,
    );
    fs.chmodSync(
      socketPath,
      scenario === "world" ? 0o777 : scenario === "named-acl" ? 0o700 : 0o770,
    );
    // Ensure an unrelated UID has explicit access even in the group-only cases.
    command("/usr/bin/setfacl", [
      "-m",
      scenario === "named-acl" ? "u:1:rw-,u:65534:rw-" : "u:1:rw-",
      "--",
      socketPath,
    ]);
    assert.equal(writableAs(1), true);
    const originalIdentity = scenario !== "fallback-group";
    const gid = originalIdentity ? 65533 : 65531;
    const supplementary = originalIdentity ? [65532] : [];
    assert.equal(
      unprivileged(gid, supplementary),
      81,
      "accessible socket must fail final unprivileged verification: " +
        scenario,
    );
    const found = await pipeline.findRootServiceSockets(
      directory,
      groups,
      credentials,
    );
    assert.equal(found.length, 1, "discover worker access: " + scenario);
    await assert.rejects(
      pipeline.verifyPrivilegedSocketsRestricted(groups, credentials),
      /did not revoke access/,
    );
    const mode = fs.statSync(socketPath).mode;
    await pipeline.restrictRootServiceSocket(found[0], credentials.userId);
    assert.equal(fs.statSync(socketPath).mode, mode);
    assert.equal(writableAs(1), true, "preserve service peer: " + scenario);
    if (scenario === "world") {
      await assert.rejects(
        previous.verifyPrivilegedSocketsRestricted(groups, credentials),
        /did not revoke access/,
      );
      console.log(
        "REPRODUCED: #465 root verification rejects worker-denied sockets with preserved mode bits.",
      );
    }
    await pipeline.verifyPrivilegedSocketsRestricted(groups, credentials);
    assert.deepEqual(
      await pipeline.findRootServiceSockets(directory, groups, credentials),
      [],
    );
    assert.equal(unprivileged(65533, [65532]), 0);
    assert.equal(unprivileged(65531), 0);
    console.log(
      "VERIFIED full socket discovery/restriction/root and unprivileged checks: " +
        scenario,
    );
  }
  for (const result of [
    { code: 2, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "probe failed" },
  ]) {
    const broken = socketPipeline(patched, directory, {
      execCommand: async () => result,
    });
    await assert.rejects(
      broken.verifyPrivilegedSocketsRestricted(groups, credentials),
      /Could not verify access/,
    );
  }
  command("/usr/bin/setfacl", ["-b", "--", socketPath]);
  fs.chownSync(socketPath, 0, 0);
}
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await verifyPipeline();
  fs.chmodSync(socketPath, 0o777);
  assert.equal(writableAs(1), true);
  await original(descriptor());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o700);
  assert.equal(
    writableAs(1),
    false,
    "original action wrongly denies the service peer",
  );
  console.log(
    "REPRODUCED: original pinned action removes unrelated service-user access.",
  );

  fs.chmodSync(socketPath, 0o777);
  await repaired(descriptor(), 65534);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o777);
  assert.equal(writableAs(65534), false, "worker must lose socket access");
  assert.equal(writableAs(1), true, "service peer must retain socket access");
  assert.equal(
    await repaired(descriptor(), 65534),
    false,
    "deny is idempotent",
  );

  const grant = childProcess.spawnSync(
    "/usr/bin/setfacl",
    ["-m", "u:1:rw-", "--", socketPath],
    { encoding: "utf8" },
  );
  assert.equal(grant.status, 0, grant.stderr);
  const before = acl();
  await repaired(descriptor(), 65533);
  const after = acl();
  for (const entry of before)
    assert.ok(after.includes(entry), "Existing ACL changed: " + entry);
  assert.equal(writableAs(65533), false);
  assert.equal(writableAs(1), true);

  await assert.rejects(repaired(descriptor(), 0), /worker UID/);
  await assert.rejects(
    repaired({ ...descriptor(), inode: -1 }, 65534),
    /changed/,
  );
  const link = path.join(directory, "socket-link");
  fs.symlinkSync(socketPath, link);
  await assert.rejects(
    repaired({ ...descriptor(), path: link }, 65534),
    /socket/,
  );
  const regular = path.join(directory, "regular");
  fs.writeFileSync(regular, "not a socket");
  await assert.rejects(repaired(descriptor(regular), 65534), /socket/);
  assert.equal(
    await repaired(
      { ...descriptor(), path: path.join(directory, "missing") },
      65534,
    ),
    false,
  );

  const copy = path.join(directory, "bundle.js");
  fs.writeFileSync(copy, bundle);
  const patchScript = fileURLToPath(
    new URL("./patch-codex-sockets.mjs", import.meta.url),
  );
  const apply = (file) =>
    childProcess.spawnSync(process.execPath, [patchScript, file], {
      encoding: "utf8",
    });
  const application = apply(copy);
  assert.equal(application.status, 0, application.stderr);
  assert.equal(fs.readFileSync(copy, "utf8"), patched);
  assert.notEqual(
    apply(copy).status,
    0,
    "second application must refuse hash mismatch",
  );
  const bundleLink = path.join(directory, "bundle-link");
  fs.symlinkSync(copy, bundleLink);
  assert.notEqual(
    apply(bundleLink).status,
    0,
    "bundle symlink must be rejected",
  );
  assert.equal(fs.readFileSync(copy, "utf8"), patched);
  console.log(
    "VERIFIED: worker denied, service peer preserved, ACL/identity/hash guards enforced.",
  );
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
