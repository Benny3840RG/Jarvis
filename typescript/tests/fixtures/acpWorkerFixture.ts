/**
 * Deterministic fake ACP worker executable (Gate-B commissioning fixture).
 *
 * Reads permission-request envelopes on stdin and replies with a fixed decision
 * taken from argv[2] (default `abstain`) using the real {@link runAcpWorker}
 * core — so spawning this as a subprocess exercises the live spawn/stdio/framing
 * path end to end, with no network and no credential. It is NOT a model-backed
 * worker; it always returns the configured decision. If argv[2] is `silent`, it
 * emits nothing, so the transport observes a crash/timeout (fail-closed).
 */

import type { AcpPermissionDecision } from "../../src/acp/acpContract.js";
import { runAcpWorker, staticDecider, type AcpDecider } from "../../src/acp/nolanAcpWorker.js";

const arg = process.argv[2] ?? "abstain";
const decide: AcpDecider =
  arg === "silent"
    ? () => {
        throw new Error("intentionally silent worker");
      }
    : staticDecider(arg as AcpPermissionDecision);

await runAcpWorker({
  input: process.stdin,
  write: (line) => process.stdout.write(line),
  decide,
});
