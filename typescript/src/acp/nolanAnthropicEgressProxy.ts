/**
 * Nolan ACP worker — Anthropic egress proxy (roadmap PR H — governed
 * commissioning slice, Gate D egress).
 *
 * The one thing the sandboxed ACP worker is allowed to reach. A minimal
 * HTTP CONNECT proxy — not a TLS-terminating one — that tunnels raw bytes to
 * exactly one hard-coded destination, `api.anthropic.com:443`, and refuses
 * every other CONNECT target outright, before ever opening an outbound
 * connection. Mirrors `githubReadEgress.ts`'s "hard-coded on purpose" origin
 * boundary, at the network layer instead of the application layer, because
 * the worker itself is sandboxed to reach nothing else at all (see
 * `docs/operations/acp-worker-sandbox.md`): the worker's own unit is
 * `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/32 ::1/128`, so this proxy
 * — listening on loopback only — is the sole network path it has, and this
 * proxy is the sole thing standing between that path and the open internet.
 *
 * CONNECT is never terminated: no TLS is decrypted here. On an approved
 * target, this process opens a real TCP connection to the real destination
 * and splices bytes bidirectionally; the worker's own TLS client still
 * negotiates end-to-end with the real Anthropic server, so this proxy never
 * sees plaintext, headers, or credentials — only opaque encrypted bytes after
 * the tunnel is established. It only ever reads the CONNECT request line and
 * headers (to make the allow/deny decision), never anything past the blank
 * line that ends them.
 *
 * Deliberately not a general-purpose proxy: no auth, no other HTTP methods, no
 * other hosts, no configuration surface beyond the approved target (which
 * defaults to the real production constants and is overridable only for
 * tests).
 */

import { connect as netConnect, createServer, type Server, type Socket } from "node:net";

/** The one destination this proxy will ever tunnel to. Hard-coded on purpose. */
export const ANTHROPIC_API_HOST = "api.anthropic.com";
export const ANTHROPIC_API_PORT = 443;

const DEFAULT_MAX_HEADER_BYTES = 8_192;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type ConnectTarget = Readonly<{ host: string; port: number }>;

/**
 * Parse an HTTP `CONNECT host:port HTTP/1.x` request line. Returns `null` for
 * anything else — a different method, a missing/invalid host:port, or a
 * malformed HTTP version token. Fail-closed: an unparseable line is refused,
 * never approved.
 */
export function parseConnectRequestLine(line: string): ConnectTarget | null {
  const match = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]\s*$/i.exec(line.trim());
  if (!match) return null;
  const authority = match[1]!;
  const lastColon = authority.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === authority.length - 1) return null;
  const host = authority.slice(0, lastColon);
  const portText = authority.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!host) return null;
  return { host, port };
}

/**
 * Whether `target` is exactly the approved destination. Case-insensitive on
 * the host (DNS names are case-insensitive); the port must match exactly. No
 * wildcard, no subdomain match, no fallback — mirrors
 * `assertGitHubApiUrl`'s strict-origin comparison.
 */
export function isApprovedConnectTarget(target: ConnectTarget, approved: ConnectTarget): boolean {
  return target.host.toLowerCase() === approved.host.toLowerCase() && target.port === approved.port;
}

/** Split a buffered HTTP request's headers on `\r\n` into non-empty lines, dropping the trailing blank line. */
function splitHeaderLines(headerBlock: string): string[] {
  return headerBlock.split("\r\n").filter((line) => line.length > 0);
}

export type AnthropicEgressProxyDeps = Readonly<{
  /** The one destination this instance approves. Defaults to the real production target. */
  approved?: ConnectTarget;
  /** Injectable upstream connector, for tests. Defaults to a real `net.connect`-based dial. */
  connectUpstream?: (target: ConnectTarget, timeoutMs: number) => Promise<Socket>;
  maxHeaderBytes?: number;
  connectTimeoutMs?: number;
}>;

function realConnectUpstream(target: ConnectTarget, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("upstream connect timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Create the CONNECT proxy server. Bind it to loopback only
 * (`server.listen(port, "127.0.0.1")`) — this proxy is not meant to be
 * reachable from the network. Every connection is handled independently;
 * a rejected or malformed request never causes an outbound connection.
 */
export function createAnthropicEgressProxyServer(deps: AnthropicEgressProxyDeps = {}): Server {
  const approved = deps.approved ?? { host: ANTHROPIC_API_HOST, port: ANTHROPIC_API_PORT };
  const connectUpstream = deps.connectUpstream ?? realConnectUpstream;
  const maxHeaderBytes = deps.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return createServer((client: Socket) => {
    let buffer = "";
    let settled = false;

    const refuse = (status: string): void => {
      if (settled) return;
      settled = true;
      client.removeAllListeners("data");
      try {
        client.end(`HTTP/1.1 ${status}\r\n\r\n`);
      } catch {
        client.destroy();
      }
    };

    client.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("latin1"); // header bytes are always ASCII; latin1 is a safe 1:1 byte mapping
      if (buffer.length > maxHeaderBytes) {
        refuse("400 Bad Request");
        return;
      }
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // still waiting for the end of headers

      // Decided one way or another for this connection: stop listening for
      // more request bytes. Do NOT set `settled` here — that flag guards
      // `refuse()` against being invoked twice, and the decision of whether
      // to refuse or proceed is made below.
      client.removeAllListeners("data");
      const headerBlock = buffer.slice(0, headerEnd);
      // Any bytes the client already sent past the blank line (e.g. a
      // pipelined TLS ClientHello) belong to the tunnel payload, not the
      // proxy's own protocol — preserve them.
      const leftover = buffer.slice(headerEnd + 4);

      const lines = splitHeaderLines(headerBlock);
      const target = lines.length > 0 ? parseConnectRequestLine(lines[0]!) : null;
      if (!target) {
        refuse("400 Bad Request");
        return;
      }
      if (!isApprovedConnectTarget(target, approved)) {
        refuse("403 Forbidden");
        return;
      }

      connectUpstream(approved, connectTimeoutMs).then(
        (upstream) => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (leftover.length > 0) upstream.write(Buffer.from(leftover, "latin1"));
          client.pipe(upstream);
          upstream.pipe(client);
          const cleanup = (): void => {
            client.destroy();
            upstream.destroy();
          };
          client.once("error", cleanup);
          client.once("close", cleanup);
          upstream.once("error", cleanup);
          upstream.once("close", cleanup);
        },
        () => refuse("502 Bad Gateway"),
      );
    });

    client.on("error", () => {
      // Best-effort teardown; a client-side error must not crash the server.
    });
  });
}
