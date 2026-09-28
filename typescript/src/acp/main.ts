/**
 * `nolan-acp-worker` entrypoint (roadmap PR H — governed commissioning slice,
 * Gate D / D0).
 *
 * The real, live worker binary that `JARVIS_ACP_WORKER_COMMAND` /
 * `JARVIS_ACP_WORKER_ARGS` point at once an owner commissions ACP (see
 * `docs/operations/acp-worker-sandbox.md`). Per {@link StdioAcpTransport}'s
 * design, the transport spawns a **fresh process per consultation** — this
 * file's whole life is: read one framed request from stdin, ask the real
 * Anthropic decider for one judgement, write one framed response to stdout
 * (or none at all on any anomaly), then exit.
 *
 * stdout is the wire-framing channel only. Nothing but a single response line
 * is ever written there; any diagnostic goes to stderr, which the transport
 * treats as the worker's ordinary log channel and never parses.
 *
 * Fail closed by construction:
 *   - No Anthropic credential configured → refuse to start at all (exit
 *     non-zero, a clear stderr message, nothing on stdout). This is a
 *     deployment error, not a per-request anomaly, but the transport treats
 *     it identically to a crash — fail-closed either way.
 *   - Any other failure (a malformed request, a decider throw, an uncaught
 *     exception) → the process exits without having written a response line.
 *     `runAcpWorker`/`handleAcpRequestLine` already guarantee this for every
 *     failure inside the request/decide path; letting an unexpected error
 *     propagate to an uncaught exception here (rather than swallowing it) is
 *     deliberate — a crash that reaches the transport as "closed before
 *     responding" is exactly the fail-closed outcome intended.
 */

import { createAnthropicDeciderFromEnv } from "./nolanAnthropicDecider.js";
import { runAcpWorker } from "./nolanAcpWorker.js";

async function main(): Promise<void> {
  const decide = createAnthropicDeciderFromEnv(process.env);
  if (!decide) {
    process.stderr.write(
      "nolan-acp-worker: no Anthropic credential configured " +
        "(CREDENTIALS_DIRECTORY / JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL); refusing to start.\n",
    );
    process.exitCode = 1;
    return;
  }

  await runAcpWorker({
    input: process.stdin,
    write: (line) => {
      process.stdout.write(line);
    },
    decide,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`nolan-acp-worker: fatal error: ${String(error)}\n`);
  process.exitCode = 1;
});
