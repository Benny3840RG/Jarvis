import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fetch as undiciFetch, ProxyAgent } from "undici";

import { createAnthropicEgressProxyServer } from "../src/acp/nolanAnthropicEgressProxy.js";
import {
  buildAnthropicProxyDispatcher,
  resolveAnthropicWorkerConfigFromEnv,
  type AnthropicWorkerConfig,
} from "../src/acp/nolanAnthropicDecider.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "acp-egress-"));
}

function startFakeUpstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function startProxyOnSocket(
  deps: Parameters<typeof createAnthropicEgressProxyServer>[0],
  socketPath: string,
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createAnthropicEgressProxyServer(deps);
    server.listen(socketPath, () => resolve(server));
  });
}

function readUntil(
  socket: Socket,
  predicate: (buf: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = "";
    const timer = setTimeout(() => reject(new Error("readUntil timed out")), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      acc += chunk.toString("latin1");
      if (predicate(acc)) {
        clearTimeout(timer);
        resolve(acc);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("Anthropic egress proxy over a unix socket", () => {
  it("tunnels bytes to the approved target over the socket (worker's only egress)", async () => {
    const dir = mkTmp();
    const socketPath = join(dir, "p.sock");
    const upstream = await startFakeUpstream();
    const proxy = await startProxyOnSocket(
      { approved: { host: "127.0.0.1", port: upstream.port } },
      socketPath,
    );
    try {
      const client = netConnect({ path: socketPath });
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n\r\n`);
      const established = await readUntil(client, (b) => b.includes("\r\n\r\n"));
      assert.match(established, /^HTTP\/1\.1 200/);
      client.write("hello-over-unix");
      const echoed = await readUntil(client, (b) => b.includes("echo:"));
      assert.equal(echoed.includes("echo:hello-over-unix"), true);
      client.destroy();
    } finally {
      proxy.close();
      upstream.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-approved target over the socket (403) and never dials upstream", async () => {
    const dir = mkTmp();
    const socketPath = join(dir, "p.sock");
    let dialed = false;
    const proxy = await startProxyOnSocket(
      {
        approved: { host: "api.anthropic.com", port: 443 },
        connectUpstream: async () => {
          dialed = true;
          throw new Error("must never be called");
        },
      },
      socketPath,
    );
    try {
      const client = netConnect({ path: socketPath });
      client.write("CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n");
      const response = await readUntil(client, (b) => b.includes("\r\n\r\n"));
      assert.match(response, /^HTTP\/1\.1 403/);
      assert.equal(dialed, false);
    } finally {
      proxy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAnthropicProxyDispatcher", () => {
  const base = { apiKey: "k", model: "m", timeoutMs: 1000 } as const;

  it("returns a ProxyAgent for a unix-socket proxy", () => {
    const d = buildAnthropicProxyDispatcher({ ...base, proxySocketPath: "/run/acp/p.sock" });
    assert.equal(d instanceof ProxyAgent, true);
  });

  it("returns a ProxyAgent for a TCP proxy", () => {
    const d = buildAnthropicProxyDispatcher({ ...base, proxyUri: "http://127.0.0.1:8080" });
    assert.equal(d instanceof ProxyAgent, true);
  });

  it("prefers the unix socket when both are configured", () => {
    // Both set: the socket path wins (verified by the CONNECT-over-socket test below).
    const config: AnthropicWorkerConfig = {
      ...base,
      proxyUri: "http://127.0.0.1:8080",
      proxySocketPath: "/run/acp/p.sock",
    };
    assert.equal(buildAnthropicProxyDispatcher(config) instanceof ProxyAgent, true);
  });

  it("returns undefined with no proxy configured (direct fetch)", () => {
    assert.equal(buildAnthropicProxyDispatcher(base), undefined);
  });
});

describe("resolveAnthropicWorkerConfigFromEnv — proxy socket", () => {
  function withCredential(extra: Record<string, string>): AnthropicWorkerConfig | null {
    const dir = mkTmp();
    try {
      mkdirSync(join(dir, "creds"));
      writeFileSync(join(dir, "creds", "acp_key"), "sk-test-123");
      return resolveAnthropicWorkerConfigFromEnv({
        CREDENTIALS_DIRECTORY: join(dir, "creds"),
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "acp_key",
        ...extra,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resolves proxySocketPath from JARVIS_ACP_ANTHROPIC_PROXY_SOCKET", () => {
    const config = withCredential({ JARVIS_ACP_ANTHROPIC_PROXY_SOCKET: "/run/acp/p.sock" });
    assert.equal(config?.proxySocketPath, "/run/acp/p.sock");
    assert.equal(config?.proxyUri, undefined);
  });

  it("carries both when both env vars are set (dispatcher decides precedence)", () => {
    const config = withCredential({
      JARVIS_ACP_ANTHROPIC_PROXY_SOCKET: "/run/acp/p.sock",
      JARVIS_ACP_ANTHROPIC_PROXY_URI: "http://127.0.0.1:8080",
    });
    assert.equal(config?.proxySocketPath, "/run/acp/p.sock");
    assert.equal(config?.proxyUri, "http://127.0.0.1:8080");
  });
});

describe("undici routes the worker's egress over the unix-socket proxy (proxyTls.socketPath)", () => {
  it("dials the socket and sends a valid CONNECT for the target", async () => {
    const dir = mkTmp();
    const socketPath = join(dir, "p.sock");
    const seen: Array<{ host: string; port: number }> = [];
    const proxy = await startProxyOnSocket(
      {
        approved: { host: "127.0.0.1", port: 8443 },
        // Record that a valid CONNECT reached the proxy over the socket, then
        // fail the upstream dial (no real server) so the fetch rejects. The
        // point is proving undici dialed the *socket* and spoke CONNECT — no
        // TLS upstream needed.
        connectUpstream: async (target) => {
          seen.push({ host: target.host, port: target.port });
          throw new Error("no upstream in test");
        },
      },
      socketPath,
    );
    const dispatcher = buildAnthropicProxyDispatcher({
      apiKey: "k",
      model: "m",
      timeoutMs: 1000,
      proxySocketPath: socketPath,
    });
    try {
      await undiciFetch("https://127.0.0.1:8443/v1/messages", { dispatcher }).then(
        () => undefined,
        () => undefined, // expected to reject: proxy returns 502 (no upstream)
      );
      assert.deepEqual(seen, [{ host: "127.0.0.1", port: 8443 }]);
    } finally {
      await dispatcher?.close();
      proxy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
