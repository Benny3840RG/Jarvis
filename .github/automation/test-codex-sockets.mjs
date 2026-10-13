// Secret-free Linux integration test. Only disposable fixture sockets change.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCodexBundle } from "./verify-codex-action.mjs";
import { socketPipeline } from "./codex-socket-test-harness.mjs";

assert.equal(process.getuid(), 0, "Run the disposable Linux fixture as root");
assert.equal(process.platform, "linux");
assert.ok(process.argv[2], "Pass the pinned upstream bundle");
const bundle = verifyCodexBundle(fs.readFileSync(process.argv[2], "utf8"));
for (const program of ["setpriv", "setfacl", "getfacl", "test"]) {
  fs.accessSync("/usr/bin/" + program, fs.constants.X_OK);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-socket-test-"));
fs.chmodSync(directory, 0o755);
const nestedDirectory = path.join(directory, "nested");
fs.mkdirSync(nestedDirectory, { mode: 0o755 });
const socketPath = path.join(nestedDirectory, "service.sock");
const server = net.createServer((socket) => socket.end());
const credentials = {
  userId: 65534,
  primaryGroupId: 65533,
  supplementaryGroupIds: [65532],
  fallbackGroupId: 65531,
};
const identities = {
  original: { uid: 65534, gid: 65533, groups: [65532] },
  fallback: { uid: 65534, gid: 65531, groups: [] },
  clearedOriginal: { uid: 65534, gid: 65533, groups: [] },
  peer: { uid: 1, gid: 65530, groups: [] },
  maskedPeer: { uid: 2, gid: 65530, groups: [] },
};
const pipeline = socketPipeline(bundle, directory);

function descriptor(file = socketPath) {
  const stats = fs.statSync(file);
  return { path: file, device: stats.dev, inode: stats.ino };
}
function command(program, args) {
  const result = childProcess.spawnSync(program, args, {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function acl() {
  return command("/usr/bin/getfacl", ["-cpnE", "--", socketPath])
    .split("\n")
    .filter(Boolean);
}
function state() {
  const { mode, uid, gid, dev, ino } = fs.statSync(socketPath);
  return { mode, uid, gid, dev, ino, acl: acl() };
}
function reset({ mode = 0o777, group = 0, grants = "u:1:rw-", mask } = {}) {
  command("/usr/bin/setfacl", ["-b", "--", socketPath]);
  fs.chownSync(socketPath, 0, group);
  fs.chmodSync(socketPath, mode);
  if (grants) command("/usr/bin/setfacl", ["-m", grants, "--", socketPath]);
  if (mask) command("/usr/bin/setfacl", ["-m", "m::" + mask, "--", socketPath]);
}
function asIdentity(identity, args) {
  return [
    "--reuid=" + identity.uid,
    "--regid=" + identity.gid,
    identity.groups.length
      ? "--groups=" + identity.groups.join(",")
      : "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    ...args,
  ];
}
function writableAs(identity) {
  const result = childProcess.spawnSync(
    "/usr/bin/setpriv",
    asIdentity(identity, ["/usr/bin/test", "-w", socketPath]),
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.equal(result.stderr, "");
  return result.status === 0;
}
function runNodeAs(identity, source, args = []) {
  // Keep the event loop live so the fixture server can accept and close real
  // connections. A synchronous child connection probe would starve it.
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      "/usr/bin/setpriv",
      asIdentity(identity, [
        process.execPath,
        "--input-type=module",
        "-e",
        source,
        ...args,
      ]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, stderr);
        assert.ok([0, 81].includes(status), stderr);
        assert.equal(stderr, "");
        resolve({ status, stdout });
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function connectAs(identity) {
  const result = await runNodeAs(
    identity,
    `
    import net from 'node:net';
    const socket = net.createConnection(process.argv[1]);
    socket.once('connect', () => { console.log('connected'); socket.end(); });
    socket.once('error', (error) => {
      if (error.code !== 'EACCES') throw error;
      console.log('denied');
      process.exitCode = 81;
    });
  `,
    [socketPath],
  );
  assert.equal(
    result.stdout.trim(),
    result.status === 0 ? "connected" : "denied",
  );
  return result.status === 0;
}

// Unprivileged identities must not need access to private checkout parents.
// Copy only the secret-free fixtures and the unchanged public upstream bundle.
for (const filename of [
  "codex-socket-test-harness.mjs",
  "verify-codex-action.mjs",
]) {
  fs.writeFileSync(
    path.join(directory, filename),
    fs.readFileSync(new URL("./" + filename, import.meta.url)),
    { mode: 0o644 },
  );
}
const fixtureBundle = path.join(directory, "bundle.js");
fs.writeFileSync(fixtureBundle, bundle, { mode: 0o644 });
const fixtureHarness = pathToFileURL(
  path.join(directory, "codex-socket-test-harness.mjs"),
).href;
async function unprivilegedVerification(identity) {
  const result = await runNodeAs(
    identity,
    `
    import fs from 'node:fs';
    import { socketPipeline } from ${JSON.stringify(fixtureHarness)};
    const source = fs.readFileSync(process.argv[1], 'utf8');
    try { await socketPipeline(source, process.argv[2]).verifyPrivilegedSocketsRestricted(); }
    catch (error) {
      if (!error.message.startsWith('drop-sudo did not revoke access')) throw error;
      process.exitCode = 81;
    }
  `,
    [fixtureBundle, directory],
  );
  return result.status;
}

async function verifyPeerAccess(scenario) {
  for (const [name, expected] of Object.entries({
    peer: true,
    ...scenario.peerAccess,
  })) {
    assert.equal(
      writableAs(identities[name]),
      expected,
      `${scenario.name}: ${name} write access`,
    );
    assert.equal(
      await connectAs(identities[name]),
      expected,
      `${scenario.name}: ${name} connection`,
    );
  }
}

async function verifyScenario(scenario) {
  reset(scenario);
  const before = state();
  await verifyPeerAccess(scenario);
  for (const [name, expected] of Object.entries(scenario.access)) {
    const identity = identities[name];
    assert.equal(
      writableAs(identity),
      expected,
      `${scenario.name}: ${name} access before restriction`,
    );
    assert.equal(
      await connectAs(identity),
      expected,
      `${scenario.name}: ${name} connection before restriction`,
    );
    assert.equal(await unprivilegedVerification(identity), expected ? 81 : 0);
  }
  const hasProbedAccess = scenario.access.original || scenario.access.fallback;
  if (hasProbedAccess) {
    await assert.rejects(
      pipeline.verifyPrivilegedSocketsRestricted(credentials),
      /drop-sudo did not revoke access/,
    );
  } else {
    await pipeline.verifyPrivilegedSocketsRestricted(credentials);
  }
  assert.equal(
    (await pipeline.findRootServiceSockets(directory, credentials)).length,
    hasProbedAccess ? 1 : 0,
  );
  const found = await pipeline.findRootServiceSockets(
    directory,
    credentials,
    true,
  );
  assert.deepEqual(found, [{ ...descriptor(), groupId: scenario.group ?? 0 }]);
  assert.equal(
    await pipeline.restrictRootServiceSocket(found[0], credentials),
    true,
  );
  const after = state();
  for (const key of ["mode", "uid", "gid", "dev", "ino"]) {
    assert.equal(after[key], before[key], `${scenario.name}: preserve ${key}`);
  }
  for (const entry of before.acl.filter(
    (entry) => !entry.startsWith("user:65534:"),
  )) {
    assert.ok(
      after.acl.includes(entry),
      `${scenario.name}: preserve unrelated ACL ${entry}`,
    );
  }
  assert.ok(after.acl.includes("user:65534:---"));
  await verifyPeerAccess(scenario);
  for (const identity of [
    identities.original,
    identities.fallback,
    identities.clearedOriginal,
  ]) {
    assert.equal(writableAs(identity), false);
    assert.equal(await connectAs(identity), false);
    assert.equal(await unprivilegedVerification(identity), 0);
  }
  await pipeline.verifyPrivilegedSocketsRestricted(credentials);
  assert.deepEqual(
    await pipeline.findRootServiceSockets(directory, credentials),
    [],
  );
  // Upstream returns true again after reapplying the same deny. Its state,
  // including all unrelated and masked grants, must still be idempotent.
  assert.equal(
    await pipeline.restrictRootServiceSocket(found[0], credentials),
    true,
  );
  assert.deepEqual(state(), after);
  console.log(
    "VERIFIED upstream discovery/restriction/root/unprivileged/access/connection pipeline: " +
      scenario.name,
  );
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  for (const scenario of [
    { name: "world", access: { original: true, fallback: true } },
    {
      name: "primary-group",
      mode: 0o770,
      group: 65533,
      access: { original: true, fallback: false },
    },
    {
      name: "supplementary-group",
      mode: 0o770,
      group: 65532,
      access: { original: true, fallback: false },
    },
    {
      name: "named-user-acl",
      mode: 0o700,
      grants: "u:1:rw-,u:65534:rw-",
      access: { original: true, fallback: true },
    },
    {
      name: "named-group-acl",
      mode: 0o700,
      grants: "u:1:rw-,g:65532:rw-",
      access: { original: true, fallback: false },
    },
    {
      name: "fallback-group",
      mode: 0o770,
      group: 65531,
      access: { original: false, fallback: true },
    },
    {
      name: "restrictive-mask",
      mode: 0o770,
      group: 65532,
      grants: "u:1:rw-,u:2:rwx",
      mask: "rw-",
      access: { original: true, fallback: false },
    },
    {
      name: "masked-unrelated-write",
      mode: 0o642,
      grants: "u:2:rw-",
      mask: "r--",
      access: { original: true, fallback: true },
      peerAccess: { maskedPeer: false },
    },
    {
      name: "existing-worker-deny",
      grants: "u:1:rw-,u:65534:---",
      access: { original: false, fallback: false },
    },
    // Both probed identities match denying groups. Removing supplementary
    // groups exposes other-write, so initial discovery must include this socket.
    {
      name: "world-write-shadowed-by-groups",
      mode: 0o747,
      group: 65531,
      grants: "u:1:rw-,g:65532:r--",
      access: { original: false, fallback: false, clearedOriginal: true },
    },
  ]) {
    await verifyScenario(scenario);
  }

  for (const result of [
    { code: 2, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "probe failed" },
  ]) {
    const broken = socketPipeline(bundle, directory, {
      execCommand: async () => result,
    });
    await assert.rejects(
      broken.verifyPrivilegedSocketsRestricted(credentials),
      /Could not verify access to a privileged service socket/,
    );
  }

  // Inject only a failing/no-op external ACL command; discovery, descriptors,
  // identity probes and verification still execute the unchanged upstream code.
  for (const ineffective of [false, true]) {
    reset();
    const before = state();
    const broken = socketPipeline(bundle, directory, {
      execCommand: async (program, args, options) => {
        if (program === "/usr/bin/setfacl") {
          if (!ineffective) throw new Error("Fixture ACL command failed");
          return { code: 0, stdout: "", stderr: "" };
        }
        return pipeline.execCommand(program, args, options);
      },
    });
    await assert.rejects(
      broken.restrictRootServiceSocket(descriptor(), credentials),
      ineffective
        ? /Could not restrict access to/
        : /Fixture ACL command failed/,
    );
    assert.deepEqual(state(), before);
    assert.equal(await connectAs(identities.original), true);
    assert.equal(await connectAs(identities.peer), true);
  }

  reset({ mode: 0o707, grants: "" });
  const emptyMask = state();
  assert.equal(await connectAs(identities.peer), true);
  await assert.rejects(
    pipeline.findRootServiceSockets(directory, credentials, true),
    /empty ACL mask while preserving other users' access/,
  );
  await assert.rejects(
    pipeline.restrictRootServiceSocket(descriptor(), credentials),
    /empty ACL mask while preserving other users' access/,
  );
  assert.deepEqual(state(), emptyMask);
  assert.equal(await connectAs(identities.peer), true);

  reset();
  await assert.rejects(
    pipeline.restrictRootServiceSocket(
      { ...descriptor(), inode: -1 },
      credentials,
    ),
    /changed while dropping privileges/,
  );
  await assert.rejects(
    pipeline.restrictRootServiceSocket(
      { ...descriptor(), device: -1 },
      credentials,
    ),
    /changed while dropping privileges/,
  );
  await assert.rejects(
    pipeline.canWriteRootServiceSocket(
      socketPath,
      { dev: -1, ino: -1 },
      credentials,
    ),
    /privileged service socket changed during discovery/,
  );
  fs.chownSync(socketPath, 1, 0);
  await assert.rejects(
    pipeline.restrictRootServiceSocket(descriptor(), credentials),
    /to be owned by root/,
  );
  fs.chownSync(socketPath, 0, 0);
  const link = path.join(directory, "socket-link");
  fs.symlinkSync(socketPath, link);
  await assert.rejects(
    pipeline.restrictRootServiceSocket(
      { ...descriptor(), path: link },
      credentials,
    ),
    /to be a socket/,
  );
  const regular = path.join(directory, "regular");
  fs.writeFileSync(regular, "not a socket");
  await assert.rejects(
    pipeline.restrictRootServiceSocket(descriptor(regular), credentials),
    /to be a socket/,
  );
  assert.equal(
    await pipeline.restrictRootServiceSocket(
      { ...descriptor(), path: path.join(directory, "missing") },
      credentials,
    ),
    false,
  );
  const directoryLink = path.join(directory, "directory-link");
  fs.symlinkSync(nestedDirectory, directoryLink);
  await assert.rejects(
    pipeline.findRootServiceSockets(directoryLink, credentials),
    (error) => ["ENOTDIR", "ELOOP"].includes(error.code),
  );
  for (const userId of [0, -1, NaN, Infinity, 1.5, "65534", 4294967295]) {
    assert.throws(
      () =>
        pipeline.parseLinuxRunnerCredentials(
          JSON.stringify({ ...credentials, userId }),
        ),
      /Invalid original Linux runner credentials/,
    );
  }
  assert.throws(
    () => socketPipeline(bundle + "\n", directory),
    /hash mismatch/,
  );
  assert.equal(fs.readFileSync(fixtureBundle, "utf8"), bundle);
  console.log(
    "VERIFIED: unmodified v1.13 isolates the runner, preserves peers and ACL masks, and fails closed on identity, ACL, probe and hash errors.",
  );
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
