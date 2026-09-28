/**
 * `jarvis-anthropic-egress-proxy` entrypoint (roadmap PR H — governed
 * commissioning slice, Gate D egress).
 *
 * A thin process wrapper around {@link createAnthropicEgressProxyServer}: read
 * the listen port from the environment, bind to **loopback only**
 * (`127.0.0.1`) — this proxy must never be reachable from the LAN — and run.
 * All allow/deny logic lives in `nolanAnthropicEgressProxy.ts` and is tested
 * there; this file adds nothing but process wiring.
 *
 * Unlike `main.ts` (the per-request ACP worker), this is a normal persistent
 * service — see `docs/operations/acp-worker-sandbox.md` for the unit file.
 */

import { createAnthropicEgressProxyServer } from "./nolanAnthropicEgressProxy.js";

function resolvePort(environment: Readonly<Record<string, string | undefined>>): number | null {
  const raw = environment.JARVIS_ACP_ANTHROPIC_EGRESS_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

function main(): void {
  const port = resolvePort(process.env);
  if (port === null) {
    process.stderr.write(
      "jarvis-anthropic-egress-proxy: JARVIS_ACP_ANTHROPIC_EGRESS_PORT is not set to a valid port; refusing to start.\n",
    );
    process.exitCode = 1;
    return;
  }

  const server = createAnthropicEgressProxyServer();
  server.on("error", (error: unknown) => {
    process.stderr.write(`jarvis-anthropic-egress-proxy: server error: ${String(error)}\n`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`jarvis-anthropic-egress-proxy: listening on 127.0.0.1:${port}\n`);
  });
}

main();
