// Temporary, hash-bound compatibility repair for openai/codex-action issue #160.
// Keep the upstream isolation strategy; restrict only its worker UID on sockets.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const CODEX_ACTION_SHA = "86365089eb2b84e0a8fb0717b304f8bdcb13b20e";
const BUNDLE_HASH =
  "c0e530e7883cc18e28f854d171f58d83e2387f7decf29f1a8ec3aa682f6601be";

// This function is inserted into the verified bundle and uses its existing
// filesystem, O_PATH and inherited-descriptor subprocess primitives.
async function restrictRootServiceSocket(socket, workerUid) {
  if (
    !Number.isSafeInteger(workerUid) ||
    workerUid <= 0 ||
    workerUid >= 4294967295
  ) {
    throw new Error("A non-root numeric worker UID is required.");
  }
  let socketHandle;
  try {
    socketHandle = await import_node_fs.promises.open(
      socket.path,
      LINUX_O_PATH | import_node_fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const stats = await socketHandle.stat();
    if (!stats.isSocket()) throw new Error("Expected a service socket.");
    if (stats.uid !== 0)
      throw new Error("Expected a root-owned service socket.");
    if (stats.dev !== socket.device || stats.ino !== socket.inode) {
      throw new Error("Service socket changed while dropping privileges.");
    }
    const options = { capture: true, inheritedFileDescriptor: socketHandle.fd };
    // The upstream helper explicitly inherits the open socket as child fd 3.
    // Using the parent's fd number here would not refer to the pinned inode.
    const target = "/proc/self/fd/3";
    const readAcl = async () => {
      const result = await execCommand(
        "/usr/bin/getfacl",
        ["-cpnE", "--", target],
        options,
      );
      const entries = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const valid = /^(?:(?:user|group):[0-9]*|mask:|other:):[r-][w-][x-]$/;
      if (
        result.code !== 0 ||
        result.stderr.trim() ||
        entries.some((entry) => !valid.test(entry)) ||
        new Set(entries).size !== entries.length ||
        !["user::", "group::", "other::"].every(
          (prefix) =>
            entries.filter((entry) => entry.startsWith(prefix)).length === 1,
        )
      ) {
        throw new Error("Could not read a complete service socket ACL.");
      }
      return entries;
    };
    const before = await readAcl();
    const userPrefix = "user:" + workerUid + ":";
    const deny = userPrefix + "---";
    if (before.includes(deny)) return false;

    // Do not widen the ACL mask or remove access from unrelated service users.
    // Any unsupported ACL operation fails the job; there is no chmod fallback.
    const result = await execCommand(
      "/usr/bin/setfacl",
      ["--no-mask", "-m", "u:" + workerUid + ":---", "--", target],
      options,
    );
    if (result.code !== 0 || result.stderr.trim()) {
      throw new Error("Could not apply the worker-only service socket ACL.");
    }
    const after = await readAcl();
    const restricted = await socketHandle.stat();
    if (
      !after.includes(deny) ||
      restricted.mode !== stats.mode ||
      restricted.uid !== stats.uid ||
      restricted.gid !== stats.gid ||
      restricted.dev !== stats.dev ||
      restricted.ino !== stats.ino ||
      before.some(
        (entry) => !entry.startsWith(userPrefix) && !after.includes(entry),
      )
    ) {
      throw new Error(
        "Could not verify worker denial with service permissions preserved.",
      );
    }
    console.log(
      "Restricted worker access to a root service socket; service permissions preserved.",
    );
    return true;
  } finally {
    await socketHandle.close();
  }
}

export function patchCodexBundle(bundle) {
  if (createHash("sha256").update(bundle).digest("hex") !== BUNDLE_HASH) {
    throw new Error(
      "Pinned Codex action bundle hash mismatch; refusing compatibility patch.",
    );
  }
  const call = "restrictRootServiceSocket(socket))";
  // Mode bits describe group/other access, but a named UID deny takes precedence.
  // Probe every potentially writable root socket under the actual worker identities,
  // using upstream's inode-pinned, inherited-fd helper (original + fallback groups).
  const discovery = `      const groupWritable = (stats.mode & 16) !== 0 && groupIds.has(stats.gid);
      const worldWritable = (stats.mode & 2) !== 0;
      const aclWritable = !groupWritable && !worldWritable && (stats.mode & 16) !== 0 && stats.isSocket() && stats.uid === 0 && await hasWritableSocketAcl(entryPath, stats, credentials);
      if (stats.isSocket() && stats.uid === 0 && (groupWritable || worldWritable || aclWritable)) {`;
  const checkedDiscovery = `      const potentiallyWritable = (stats.mode & 18) !== 0;
      if (stats.isSocket() && stats.uid === 0 && potentiallyWritable && await hasWritableSocketAcl(entryPath, stats, credentials)) {`;
  const start = bundle.indexOf("async function restrictRootServiceSocket(");
  const end = bundle.indexOf(
    "\nasync function verifyPrivilegedSocketsRestricted(",
    start,
  );
  if (
    bundle.split(call).length !== 2 ||
    bundle.split(discovery).length !== 2 ||
    start < 0 ||
    end <= start
  ) {
    throw new Error("Pinned Codex action socket patch boundary is invalid.");
  }
  return (
    bundle.slice(0, start) +
    restrictRootServiceSocket.toString() +
    "\n" +
    bundle.slice(end)
  )
    .replace(discovery, checkedDiscovery)
    .replace(
      call,
      "restrictRootServiceSocket(socket, linuxSocketCredentials.userId))",
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux" || process.argv.length !== 3) {
    throw new Error(
      "Usage on Linux: node patch-codex-sockets.mjs <pinned-action-bundle>",
    );
  }
  const path = process.argv[2];
  const fd = fs.openSync(
    path,
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 16 * 1024 * 1024) {
      throw new Error("Expected a regular pinned action bundle.");
    }
    const patched = Buffer.from(patchCodexBundle(fs.readFileSync(fd, "utf8")));
    let offset = 0;
    while (offset < patched.length) {
      const count = fs.writeSync(
        fd,
        patched,
        offset,
        patched.length - offset,
        offset,
      );
      if (count <= 0)
        throw new Error("Could not write complete compatibility patch.");
      offset += count;
    }
    fs.ftruncateSync(fd, patched.length);
    const after = fs.lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !after.isFile()
    ) {
      throw new Error("Action bundle changed during compatibility patch.");
    }
    console.log(
      "Applied hash-verified worker-only socket compatibility repair.",
    );
  } finally {
    fs.closeSync(fd);
  }
}
