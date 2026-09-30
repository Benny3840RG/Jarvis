/**
 * `jarvis-anthropic-egress-proxy` entrypoint (roadmap PR H — governed
 * commissioning slice, Gate D egress).
 *
 * A thin process wrapper around {@link createAnthropicEgressProxyServer}. It
 * binds to one of two local endpoints, chosen by the environment:
 *
 *   - `JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET` — a **unix socket** path (preferred).
 *     This is the endpoint a `PrivateNetwork=yes` worker reaches: the worker has
 *     its own empty network namespace (no host loopback at all), and the socket
 *     is bind-mounted in, so the worker can reach *only* this proxy and no
 *     sibling localhost service. Access control is the socket's directory
 *     (systemd `RuntimeDirectory` + group), not code — see the runbook.
 *   - `JARVIS_ACP_ANTHROPIC_EGRESS_PORT` — a TCP port, bound to `127.0.0.1` only
 *     (the loopback/veth topology). Never bound to a routable address.
 *
 * The socket path takes precedence when both are set. All allow/deny logic
 * lives in `nolanAnthropicEgressProxy.ts` and is tested there; this file adds
 * nothing but process wiring. Unlike `main.ts` (the per-request ACP worker),
 * this is a normal persistent service — see `docs/operations/acp-worker-sandbox.md`.
 */

import { unlinkSync } from "node:fs";

import { createAnthropicEgressProxyServer } from "./nolanAnthropicEgressProxy.js";

function resolvePort(environment: Readonly<Record<string, string | undefined>>): number | null {
  const raw = environment.JARVIS_ACP_ANTHROPIC_EGRESS_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

function main(): void {
  const socketPath = process.env.JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET?.trim();
  const port = resolvePort(process.env);

  const server = createAnthropicEgressProxyServer();
  server.on("error", (error: unknown) => {
    process.stderr.write(`jarvis-anthropic-egress-proxy: server error: ${String(error)}\n`);
    process.exitCode = 1;
  });

  if (socketPath) {
    // Best-effort removal of a stale socket from a previous run; a fresh
    // systemd RuntimeDirectory avoids this entirely.
    try {
      unlinkSync(socketPath);
    } catch {
      // No stale socket (or not removable) — listen() will surface a real bind error.
    }
    server.listen(socketPath, () => {
      process.stderr.write(`jarvis-anthropic-egress-proxy: listening on unix:${socketPath}\n`);
    });
    return;
  }

  if (port === null) {
    process.stderr.write(
      "jarvis-anthropic-egress-proxy: neither JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET nor a valid " +
        "JARVIS_ACP_ANTHROPIC_EGRESS_PORT is set; refusing to start.\n",
    );
    process.exitCode = 1;
    return;
  }

  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`jarvis-anthropic-egress-proxy: listening on 127.0.0.1:${port}\n`);
  });
}

main();
