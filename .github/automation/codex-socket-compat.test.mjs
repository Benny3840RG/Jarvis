import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { socketPipeline } from "./codex-socket-test-harness.mjs";
import { verifyCodexBundle } from "./verify-codex-action.mjs";

const bundlePath = process.env.CODEX_ACTION_BUNDLE;
const bundle = bundlePath ? fs.readFileSync(bundlePath, "utf8") : null;
const options = {
  skip:
    !bundlePath &&
    "Set CODEX_ACTION_BUNDLE; Linux CI supplies the pinned bundle",
};
const directory = "/fixture";
const descriptor = { path: "/fixture/service.sock", device: 1, inode: 2 };
const credentials = {
  userId: 1001,
  primaryGroupId: 1002,
  supplementaryGroupIds: [999],
  fallbackGroupId: 65534,
};
const denied = { code: 1, stdout: "", stderr: "" };
const allowed = { code: 0, stdout: "", stderr: "" };
const osError = (code) =>
  Object.assign(new Error("Fixture OS error"), { code });

// Only OS boundaries are simulated here. Secret-free Linux CI also runs the
// same verified, unmodified pipeline against real sockets and kernel ACLs.
function fixture({
  inode = 2,
  device = 1,
  uid = 0,
  socket = true,
  mode = 0o140777,
  openError,
  directoryError,
  aclError = false,
  ineffectiveDeny = false,
  probeResult,
  initiallyDenied = false,
  accessError,
} = {}) {
  let workerDenied = initiallyDenied;
  let opened = 0;
  let closed = 0;
  let acl = [
    "user::rwx",
    "user:1:rw-",
    "group::rwx",
    "mask::rwx",
    "other::rwx",
  ];
  const commands = [];
  const stats = () => ({
    mode,
    dev: device,
    ino: inode,
    uid,
    gid: 0,
    isSocket: () => socket,
  });
  const os = {
    constants: fs.constants,
    promises: {
      open: async (file, flags) => {
        assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
        const isDirectory = file === directory;
        if (isDirectory) {
          assert.ok(flags & fs.constants.O_DIRECTORY);
          if (directoryError) throw osError(directoryError);
        } else {
          assert.ok(
            flags & 0o10000000,
            "socket must be inode-pinned with O_PATH",
          );
          if (openError) throw osError(openError);
        }
        opened++;
        return {
          fd: isDirectory ? 11 : 12,
          stat: async () => stats(),
          close: async () => {
            closed++;
          },
        };
      },
      readdir: async (file, opts) => {
        assert.equal(file, "/proc/self/fd/11");
        assert.deepEqual(opts, { withFileTypes: true });
        return [
          {
            name: "service.sock",
            isDirectory: () => false,
            isSocket: () => true,
          },
        ];
      },
      lstat: async () => stats(),
      access: async (file, flags) => {
        assert.equal(file, "/proc/self/fd/12");
        assert.equal(flags, fs.constants.W_OK);
        if (accessError) throw osError(accessError);
        if (workerDenied) throw osError("EACCES");
      },
    },
  };
  const command = async (name, args, opts) => {
    commands.push({ name, args, options: opts });
    assert.equal(opts.inheritedFileDescriptor, 12);
    assert.equal(opts.capture, true);
    assert.equal(args.at(-1), "/proc/self/fd/3");
    if (name === "/usr/bin/setfacl") {
      assert.deepEqual(args, [
        "-n",
        "-m",
        "u:1001:---",
        "--",
        "/proc/self/fd/3",
      ]);
      if (aclError) throw new Error("Fixture ACL command failed");
      if (!ineffectiveDeny) {
        workerDenied = true;
        acl = [
          ...acl.filter((entry) => !entry.startsWith("user:1001:")),
          "user:1001:---",
        ];
      }
      return allowed;
    }
    assert.equal(name, "/usr/bin/setpriv");
    assert.equal(opts.ignoreFailure, true);
    assert.equal(args[0], "--reuid=1001");
    assert.deepEqual(args.slice(3), [
      "--",
      "/usr/bin/test",
      "-w",
      "/proc/self/fd/3",
    ]);
    return probeResult?.(args) ?? (workerDenied ? denied : allowed);
  };
  const pipeline = socketPipeline(bundle, directory, {
    fs: os,
    execCommand: command,
  });
  return {
    pipeline,
    snapshot: () => ({
      mode,
      opened,
      closed,
      acl: [...acl],
      commands: [...commands],
    }),
  };
}

function assertClosed(f) {
  assert.equal(
    f.snapshot().closed,
    f.snapshot().opened,
    "all pinned descriptors must close",
  );
}

test(
  "fixture verifies upstream bytes unchanged and rejects altered bytes",
  options,
  () => {
    assert.equal(verifyCodexBundle(bundle), bundle);
    assert.equal(verifyCodexBundle(verifyCodexBundle(bundle)), bundle);
    assert.throws(
      () => socketPipeline(bundle + "\n", directory),
      /hash mismatch/,
    );
  },
);

test(
  "whole pipeline discovers, denies and verifies worker access without changing peer ACLs or mode",
  options,
  async () => {
    const f = fixture();
    const before = f.snapshot();
    const found = await f.pipeline.findRootServiceSockets(
      directory,
      credentials,
      true,
    );
    assert.deepEqual(found, [{ ...descriptor, groupId: 0 }]);
    await assert.rejects(
      f.pipeline.verifyPrivilegedSocketsRestricted(credentials),
      /drop-sudo did not revoke access to \/fixture\/service\.sock/,
    );
    assert.equal(
      await f.pipeline.restrictRootServiceSocket(found[0], credentials),
      true,
    );
    assert.equal(f.snapshot().mode, before.mode);
    for (const entry of before.acl) assert.ok(f.snapshot().acl.includes(entry));
    assert.ok(f.snapshot().acl.includes("user:1001:---"));
    await f.pipeline.verifyPrivilegedSocketsRestricted(credentials);
    assert.deepEqual(
      await f.pipeline.findRootServiceSockets(directory, credentials),
      [],
    );
    await f.pipeline.verifyPrivilegedSocketsRestricted();
    const after = f.snapshot();
    assert.equal(
      await f.pipeline.restrictRootServiceSocket(descriptor, credentials),
      true,
    );
    assert.deepEqual(
      f.snapshot().acl,
      after.acl,
      "repeated upstream restrictions leave ACL state unchanged",
    );
    assert.equal(f.snapshot().mode, before.mode);
    assertClosed(f);
  },
);

test(
  "root verifier honours named-user deny despite world-writable mode and probes both identities",
  options,
  async () => {
    const f = fixture({ initiallyDenied: true });
    await f.pipeline.verifyPrivilegedSocketsRestricted(credentials);
    assert.deepEqual(
      f.snapshot().commands.map(({ args }) => args.slice(0, 3)),
      [
        ["--reuid=1001", "--regid=1002", "--groups=999"],
        ["--reuid=1001", "--regid=65534", "--clear-groups"],
      ],
    );
    assertClosed(f);
  },
);

test(
  "fallback-group-only access is discovered and rejected by root verification",
  options,
  async () => {
    const f = fixture({
      mode: 0o140770,
      probeResult: (args) => (args[1] === "--regid=65534" ? allowed : denied),
    });
    assert.equal(
      (await f.pipeline.findRootServiceSockets(directory, credentials)).length,
      1,
    );
    await assert.rejects(
      f.pipeline.verifyPrivilegedSocketsRestricted(credentials),
      /drop-sudo did not revoke access/,
    );
    assertClosed(f);
  },
);

test(
  "initial discovery includes world-writable sockets even if current groups shadow access",
  options,
  async () => {
    const f = fixture({ initiallyDenied: true });
    assert.deepEqual(
      await f.pipeline.findRootServiceSockets(directory, credentials),
      [],
    );
    assert.equal(
      (await f.pipeline.findRootServiceSockets(directory, credentials, true))
        .length,
      1,
    );
    assertClosed(f);
  },
);

test(
  "restriction rejects changed inode or device, non-root owner, and non-socket specifically",
  options,
  async () => {
    for (const [values, message] of [
      [{ inode: 3 }, /changed while dropping privileges/],
      [{ device: 2 }, /changed while dropping privileges/],
      [{ uid: 1 }, /to be owned by root/],
      [{ socket: false }, /to be a socket/],
    ]) {
      const f = fixture(values);
      await assert.rejects(
        f.pipeline.restrictRootServiceSocket(descriptor, credentials),
        message,
      );
      assert.equal(f.snapshot().commands.length, 0);
      assertClosed(f);
    }
  },
);

test(
  "discovery rejects replaced sockets before probing access",
  options,
  async () => {
    for (const values of [
      { inode: 3 },
      { device: 2 },
      { uid: 1 },
      { socket: false },
    ]) {
      const f = fixture(values);
      await assert.rejects(
        f.pipeline.canWriteRootServiceSocket(
          descriptor.path,
          { dev: 1, ino: 2 },
          credentials,
        ),
        /privileged service socket changed during discovery/,
      );
      assert.equal(f.snapshot().commands.length, 0);
      assertClosed(f);
    }
  },
);

test(
  "missing sockets return false while unexpected socket-open errors propagate",
  options,
  async () => {
    const missing = fixture({ openError: "ENOENT" });
    assert.equal(
      await missing.pipeline.restrictRootServiceSocket(descriptor, credentials),
      false,
    );
    assert.equal(
      await missing.pipeline.canWriteRootServiceSocket(
        descriptor.path,
        { dev: 1, ino: 2 },
        credentials,
      ),
      false,
    );
    for (const code of ["EACCES", "ELOOP", "EIO"]) {
      const f = fixture({ openError: code });
      await assert.rejects(
        f.pipeline.restrictRootServiceSocket(descriptor, credentials),
        { code },
      );
      assertClosed(f);
    }
  },
);

test(
  "upstream credential parser rejects unsafe runner IDs before isolation",
  options,
  () => {
    const { parseLinuxRunnerCredentials } = socketPipeline(bundle, directory);
    for (const userId of [0, -1, NaN, Infinity, 1.5, "1001", 4294967295]) {
      assert.throws(
        () =>
          parseLinuxRunnerCredentials(
            JSON.stringify({ ...credentials, userId }),
          ),
        /Invalid original Linux runner credentials/,
      );
    }
    for (const values of [
      { primaryGroupId: -1 },
      { supplementaryGroupIds: ["999"] },
      { supplementaryGroupIds: [4294967295] },
    ]) {
      assert.throws(
        () =>
          parseLinuxRunnerCredentials(
            JSON.stringify({ ...credentials, ...values }),
          ),
        /Invalid original Linux runner credentials/,
      );
    }
    assert.deepEqual(
      parseLinuxRunnerCredentials(
        JSON.stringify({ ...credentials, supplementaryGroupIds: [999, 999] }),
      ),
      {
        userId: 1001,
        primaryGroupId: 1002,
        supplementaryGroupIds: [999],
      },
    );
  },
);

test(
  "ACL command failures and ineffective deny fail closed with exact errors",
  options,
  async () => {
    for (const [values, message] of [
      [{ aclError: true }, /Fixture ACL command failed/],
      [
        { ineffectiveDeny: true },
        /Could not restrict access to \/fixture\/service\.sock/,
      ],
    ]) {
      const f = fixture(values);
      await assert.rejects(
        f.pipeline.restrictRootServiceSocket(descriptor, credentials),
        message,
      );
      assert.equal(f.snapshot().mode, 0o140777);
      assertClosed(f);
    }
  },
);

test(
  "empty ACL masks fail closed before any permission changes",
  options,
  async () => {
    const f = fixture({ mode: 0o140707 });
    await assert.rejects(
      f.pipeline.findRootServiceSockets(directory, credentials, true),
      /empty ACL mask while preserving other users' access/,
    );
    await assert.rejects(
      f.pipeline.restrictRootServiceSocket(descriptor, credentials),
      /empty ACL mask while preserving other users' access/,
    );
    assert.equal(f.snapshot().commands.length, 0);
    assert.equal(f.snapshot().mode, 0o140707);
    assertClosed(f);
  },
);

test(
  "unexpected probe exits and stderr are errors rather than proof of isolation",
  options,
  async () => {
    for (const result of [
      { code: 2, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "probe failed" },
    ]) {
      const f = fixture({ probeResult: () => result });
      await assert.rejects(
        f.pipeline.verifyPrivilegedSocketsRestricted(credentials),
        /Could not verify access to a privileged service socket/,
      );
      await assert.rejects(
        f.pipeline.restrictRootServiceSocket(descriptor, credentials),
        /Could not verify access to a privileged service socket/,
      );
      assertClosed(f);
    }
  },
);

test(
  "unprivileged verification fails for access and accepts only expected denial errors",
  options,
  async () => {
    await assert.rejects(
      fixture().pipeline.verifyPrivilegedSocketsRestricted(),
      /drop-sudo did not revoke access/,
    );
    for (const code of ["EACCES", "EPERM", "ENOENT"]) {
      const f = fixture({ accessError: code });
      await f.pipeline.verifyPrivilegedSocketsRestricted();
      assertClosed(f);
    }
    const f = fixture({ accessError: "EIO" });
    await assert.rejects(f.pipeline.verifyPrivilegedSocketsRestricted(), {
      code: "EIO",
    });
    assertClosed(f);
  },
);

test(
  "root discovery propagates directory denial while unprivileged discovery tolerates it",
  options,
  async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const f = fixture({ directoryError: code });
      await assert.rejects(
        f.pipeline.findRootServiceSockets(directory, credentials),
        { code },
      );
      assert.deepEqual(await f.pipeline.findRootServiceSockets(directory), []);
    }
    assert.deepEqual(
      await fixture({
        directoryError: "ENOENT",
      }).pipeline.findRootServiceSockets(directory, credentials),
      [],
    );
    await assert.rejects(
      fixture({ directoryError: "EIO" }).pipeline.findRootServiceSockets(
        directory,
      ),
      { code: "EIO" },
    );
  },
);
