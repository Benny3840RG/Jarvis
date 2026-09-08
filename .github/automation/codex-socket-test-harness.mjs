// Execute the actual pinned action functions; inject only OS boundaries/fixture root.
import * as fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end <= start) throw new Error("Invalid fixture boundary");
  return source.slice(start, end);
}

export function socketPipeline(source, directory, options = {}) {
  const execSource = section(
    source,
    "async function execCommand(command, args, options = {})",
    "\n\n// src/checkActorPermissions.ts",
  );
  const execCommand =
    options.execCommand ??
    new Function("import_node_child_process", "return (" + execSource + ");")(
      childProcess,
    );
  const discovery = section(
    options.discoverySource ?? source,
    "async function findRootServiceSockets(",
    "\nasync function hasWritableSocketAcl(",
  );
  const remaining = section(
    source,
    "async function hasWritableSocketAcl(",
    "\nasync function ensurePasswordlessSudo(",
  );
  return new Function(
    "import_node_fs",
    "path2",
    "LINUX_O_PATH",
    "execCommand",
    "LINUX_RUNTIME_DIRECTORY",
    "process",
    discovery +
      "\n" +
      remaining +
      "\nreturn { findRootServiceSockets, restrictRootServiceSocket, verifyPrivilegedSocketsRestricted };",
  )(
    options.fs ?? fs,
    path,
    0o10000000,
    execCommand,
    directory,
    options.process ?? process,
  );
}
