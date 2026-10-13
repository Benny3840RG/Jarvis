// Execute verified upstream functions unchanged; inject only OS boundaries and
// the disposable fixture root, never alternate discovery or restriction code.
import * as fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import { verifyCodexBundle } from "./verify-codex-action.mjs";

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end <= start) throw new Error("Invalid fixture boundary");
  return source.slice(start, end);
}

export function socketPipeline(bundle, directory, options = {}) {
  const source = verifyCodexBundle(bundle);
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
  const credentials = section(
    source,
    "function validId(value)",
    "\nfunction captureLinuxRunnerCredentials(",
  );
  const pipeline = section(
    source,
    "async function findRootServiceSockets(",
    "\nasync function ensurePasswordlessSudo(",
  );
  return new Function(
    "import_node_fs",
    "path2",
    "LINUX_O_PATH",
    "execCommand",
    "LINUX_RUNTIME_DIRECTORY",
    credentials +
      "\n" +
      pipeline +
      "\nreturn { execCommand, parseLinuxRunnerCredentials, findRootServiceSockets, canWriteRootServiceSocket, restrictRootServiceSocket, verifyPrivilegedSocketsRestricted };",
  )(options.fs ?? fs, path, 0o10000000, execCommand, directory);
}
