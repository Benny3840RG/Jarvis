// Secret-free Linux integration test. Never touches host service sockets.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchCodexBundle } from "./patch-codex-sockets.mjs";

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
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
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
