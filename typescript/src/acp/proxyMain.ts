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
 *     sibling localhost service. This entrypoint sets the socket to mode 0660
 *     (owner + group rw) so the worker's shared group can connect regardless of
 *     the service umask; the socket's group and the directory come from the
 *     unit's `Group=` / `RuntimeDirectory=` — see the runbook.
 *   - `JARVIS_ACP_ANTHROPIC_EGRESS_PORT` — a TCP port, bound to `127.0.0.1` only
 *     (the loopback/veth topology). Never bound to a routable address.
 *
 * The socket path takes precedence when both are set. All allow/deny logic
 * lives in `nolanAnthropicEgressProxy.ts` and is tested there; this file adds
 * nothing but process wiring. Unlike `main.ts` (the per-request ACP worker),
 * this is a normal persistent service — see `docs/operations/acp-worker-sandbox.md`.
 */

import { chmodSync, unlinkSync } from "node:fs";

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
      // The socket must be group-accessible so the worker (a *different*
      // account, in a shared group — see the runbook) can connect: connecting
      // to an AF_UNIX socket needs write permission on it. A restrictive
      // service UMask (e.g. 0077) would otherwise leave it mode 0700
      // (owner-only) and the worker could not connect. Set 0o660 explicitly so
      // access is exactly {owner, shared group} regardless of umask; the
      // socket's group is the unit's `Group=`, and the shared group is granted
      // there — no world access. Best-effort: a chmod failure is logged, not fatal.
      try {
        chmodSync(socketPath, 0o660);
      } catch (error: unknown) {
        process.stderr.write(
          `jarvis-anthropic-egress-proxy: could not chmod ${socketPath}: ${String(error)}\n`,
        );
      }
      process.stderr.write(
        `jarvis-anthropic-egress-proxy: listening on unix:${socketPath} (mode 0660)\n`,
      );
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
