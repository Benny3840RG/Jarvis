import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { socketPipeline } from "./codex-socket-test-harness.mjs";

const bundlePath = process.env.CODEX_ACTION_BUNDLE;
const original = process.env.CODEX_SOCKET_TEST_MODE === "original";
const bundle = bundlePath ? fs.readFileSync(bundlePath, "utf8") : null;
let patch;
if (bundle && !original) {
  ({ patchCodexBundle: patch } = await import("./patch-codex-sockets.mjs"));
}

function restriction() {
  const source = original ? bundle : patch(bundle);
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
  );
}

// Local sandbox cannot bind Unix sockets. Fake only the OS boundary here;
// secret-free Linux CI additionally executes the real socket/ACL fixture.
function fixture({
  inode = 2,
  uid = 0,
  socket = true,
  failCommand = false,
  corruptAcl = false,
  corruptMode = false,
} = {}) {
  let mode = 0o140777;
  let closed = false;
  let acl = ["user::rwx", "group::rwx", "other::rwx"];
  const handle = {
    fd: 12,
    stat: async () => ({
      mode,
      dev: 1,
      ino: inode,
      uid,
      isSocket: () => socket,
    }),
    close: async () => {
      closed = true;
    },
  };
  const os = {
    constants: fs.constants,
    promises: {
      open: async (_path, flags) => {
        assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
        return handle;
      },
      chmod: async (_path, value) => {
        mode = (mode & ~0o777) | value;
      },
    },
  };
  const command = async (name, args, options) => {
    assert.equal(options.inheritedFileDescriptor, 12);
    assert.equal(options.capture, true);
    assert.equal(args.at(-1), "/proc/self/fd/3");
    if (failCommand) throw new Error("ACL command failed");
    if (name === "/usr/bin/getfacl")
      return { code: 0, stdout: acl.join("\n") + "\n", stderr: "" };
    assert.equal(name, "/usr/bin/setfacl");
    assert.deepEqual(args, [
      "--no-mask",
      "-m",
      "u:1001:---",
      "--",
      "/proc/self/fd/3",
    ]);
    if (!corruptAcl) acl = [...acl, "user:1001:---", "mask::rwx"];
    if (corruptMode) mode = 0o140700;
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    run: () => restriction()(os, 0o10000000, command),
    snapshot: () => ({ mode, closed, acl }),
  };
}

const options = {
  skip:
    !bundlePath &&
    "Set CODEX_ACTION_BUNDLE; Linux CI supplies the pinned bundle",
};
const descriptor = { path: "/fixture/service.sock", device: 1, inode: 2 };

test(
  "root verifier honours a worker deny despite world-writable socket mode",
  options,
  async () => {
    const stats = {
      mode: 0o140777,
      uid: 0,
      gid: 0,
      dev: 1,
      ino: 2,
      isSocket: () => true,
    };
    const os = {
      constants: fs.constants,
      promises: {
        open: async () => ({
          fd: 12,
          stat: async () => stats,
          close: async () => {},
        }),
        readdir: async () => [
          {
            name: "service.sock",
            isDirectory: () => false,
            isSocket: () => true,
          },
        ],
        lstat: async () => stats,
      },
    };
    const credentials = {
      userId: 1001,
      primaryGroupId: 1001,
      supplementaryGroupIds: [999],
      fallbackGroupId: 65534,
    };
    const pipeline = socketPipeline(patch(bundle), "/fixture", {
      fs: os,
      process: { getuid: () => 0 },
      execCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    await pipeline.verifyPrivilegedSocketsRestricted(
      new Set([999, 65534]),
      credentials,
    );
  },
);

test(
  "socket restriction preserves service permissions while denying the worker",
  options,
  async () => {
    const f = fixture();
    await f.run()(descriptor, 1001);
    assert.equal(
      f.snapshot().mode & 0o777,
      0o777,
      "worker isolation must not chmod shared service sockets to 0700",
    );
    assert.ok(f.snapshot().acl.includes("user:1001:---"));
    assert.equal(f.snapshot().closed, true);
  },
);

test(
  "socket restriction rejects changed identity, non-root owners and non-sockets",
  options,
  async () => {
    for (const values of [{ inode: 3 }, { uid: 1 }, { socket: false }]) {
      const f = fixture(values);
      await assert.rejects(f.run()(descriptor, 1001));
      assert.equal(f.snapshot().closed, true);
      assert.equal(f.snapshot().mode & 0o777, 0o777);
    }
  },
);

test("socket restriction rejects unsafe worker UIDs", options, async () => {
  for (const uid of [0, -1, NaN, Infinity, 1.5, "1001", 4294967295]) {
    const f = fixture();
    await assert.rejects(f.run()(descriptor, uid), /worker UID/);
    assert.equal(f.snapshot().mode & 0o777, 0o777);
  }
});

test(
  "ACL errors and ineffective restrictions fail closed without a chmod fallback",
  options,
  async () => {
    for (const values of [
      { failCommand: true },
      { corruptAcl: true },
      { corruptMode: true },
    ]) {
      const f = fixture(values);
      await assert.rejects(f.run()(descriptor, 1001));
      assert.equal(f.snapshot().closed, true);
      if (!values.corruptMode) assert.equal(f.snapshot().mode & 0o777, 0o777);
    }
  },
);

test(
  "compatibility patch refuses changed upstream bytes and a second application",
  options,
  () => {
    if (original) return;
    assert.throws(() => patch(bundle + "\n"), /hash/);
    assert.throws(() => patch(patch(bundle)), /hash/);
    const patched = patch(bundle);
    assert.ok(
      patched.includes(
        "restrictRootServiceSocket(socket, linuxSocketCredentials.userId)",
      ),
    );
  },
);
