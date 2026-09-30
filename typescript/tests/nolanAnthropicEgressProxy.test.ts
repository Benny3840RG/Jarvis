import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { describe, it } from "node:test";

import {
  ANTHROPIC_API_HOST,
  ANTHROPIC_API_PORT,
  createAnthropicEgressProxyServer,
  isApprovedConnectTarget,
  parseConnectRequestLine,
} from "../src/acp/nolanAnthropicEgressProxy.js";

describe("parseConnectRequestLine", () => {
  it("parses a well-formed CONNECT line", () => {
    assert.deepEqual(parseConnectRequestLine("CONNECT api.anthropic.com:443 HTTP/1.1"), {
      host: "api.anthropic.com",
      port: 443,
    });
  });

  it("accepts HTTP/1.0 too, and tolerates surrounding whitespace", () => {
    assert.deepEqual(parseConnectRequestLine("  CONNECT x:1 HTTP/1.0  "), { host: "x", port: 1 });
  });

  it("rejects a non-CONNECT method", () => {
    assert.equal(parseConnectRequestLine("GET api.anthropic.com:443 HTTP/1.1"), null);
  });

  it("rejects a missing port, a non-numeric port, and an out-of-range port", () => {
    assert.equal(parseConnectRequestLine("CONNECT api.anthropic.com HTTP/1.1"), null);
    assert.equal(parseConnectRequestLine("CONNECT api.anthropic.com: HTTP/1.1"), null);
    assert.equal(parseConnectRequestLine("CONNECT api.anthropic.com:abc HTTP/1.1"), null);
    assert.equal(parseConnectRequestLine("CONNECT api.anthropic.com:99999 HTTP/1.1"), null);
  });

  it("rejects a blank host", () => {
    assert.equal(parseConnectRequestLine("CONNECT :443 HTTP/1.1"), null);
  });

  it("rejects garbage and an unsupported HTTP version", () => {
    assert.equal(parseConnectRequestLine("not a request line at all"), null);
    assert.equal(parseConnectRequestLine("CONNECT api.anthropic.com:443 HTTP/2"), null);
  });
});

describe("isApprovedConnectTarget", () => {
  const approved = { host: "api.anthropic.com", port: 443 };

  it("matches the exact host and port, case-insensitively on host", () => {
    assert.equal(isApprovedConnectTarget({ host: "api.anthropic.com", port: 443 }, approved), true);
    assert.equal(isApprovedConnectTarget({ host: "API.ANTHROPIC.COM", port: 443 }, approved), true);
  });

  it("rejects a different host, a different port, a subdomain, and a look-alike", () => {
    assert.equal(isApprovedConnectTarget({ host: "example.com", port: 443 }, approved), false);
    assert.equal(isApprovedConnectTarget({ host: "api.anthropic.com", port: 80 }, approved), false);
    assert.equal(
      isApprovedConnectTarget({ host: "evil.api.anthropic.com", port: 443 }, approved),
      false,
    );
    assert.equal(
      isApprovedConnectTarget({ host: "api.anthropic.com.evil.com", port: 443 }, approved),
      false,
    );
  });
});

describe("production defaults", () => {
  it("are exactly api.anthropic.com:443", () => {
    assert.equal(ANTHROPIC_API_HOST, "api.anthropic.com");
    assert.equal(ANTHROPIC_API_PORT, 443);
  });
});

/** Start a bare TCP echo-ish server standing in for the real upstream (never the real Anthropic host). */
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

function startProxy(deps: Parameters<typeof createAnthropicEgressProxyServer>[0]): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createAnthropicEgressProxyServer(deps);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function rawConnect(port: number): Socket {
  return netConnect({ host: "127.0.0.1", port });
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

describe("createAnthropicEgressProxyServer — end to end over real sockets", () => {
  it("tunnels bytes to the approved target and never inspects them past the headers", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startProxy({ approved: { host: "127.0.0.1", port: upstream.port } });
    try {
      const client = rawConnect(proxy.port);
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
      const established = await readUntil(client, (buf) => buf.includes("\r\n\r\n"));
      assert.match(established, /^HTTP\/1\.1 200/);

      client.write("hello-through-the-tunnel");
      const echoed = await readUntil(client, (buf) => buf.includes("echo:"));
      assert.equal(echoed.includes("echo:hello-through-the-tunnel"), true);
      client.destroy();
    } finally {
      proxy.server.close();
      upstream.server.close();
    }
  });

  it("preserves bytes sent immediately after the blank line (pipelined ClientHello)", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startProxy({ approved: { host: "127.0.0.1", port: upstream.port } });
    try {
      const client = rawConnect(proxy.port);
      // Send the CONNECT request and payload in one write, as a TLS client
      // eager to send ClientHello right after would.
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n\r\npipelined-bytes`);
      const all = await readUntil(client, (buf) => buf.includes("echo:"));
      assert.match(all, /^HTTP\/1\.1 200/);
      assert.equal(all.includes("echo:pipelined-bytes"), true);
      client.destroy();
    } finally {
      proxy.server.close();
      upstream.server.close();
    }
  });

  it("refuses a CONNECT to any host other than the approved one, and never dials upstream", async () => {
    let dialed = false;
    const proxy = await startProxy({
      approved: { host: "api.anthropic.com", port: 443 },
      connectUpstream: async () => {
        dialed = true;
        throw new Error("must never be called");
      },
    });
    try {
      const client = rawConnect(proxy.port);
      client.write("CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n");
      const response = await readUntil(client, (buf) => buf.includes("\r\n\r\n"));
      assert.match(response, /^HTTP\/1\.1 403/);
      assert.equal(dialed, false);
    } finally {
      proxy.server.close();
    }
  });

  it("refuses a malformed request and never dials upstream", async () => {
    let dialed = false;
    const proxy = await startProxy({
      connectUpstream: async () => {
        dialed = true;
        throw new Error("must never be called");
      },
    });
    try {
      const client = rawConnect(proxy.port);
      client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      const response = await readUntil(client, (buf) => buf.includes("\r\n\r\n"));
      assert.match(response, /^HTTP\/1\.1 400/);
      assert.equal(dialed, false);
    } finally {
      proxy.server.close();
    }
  });

  it("refuses an oversized header block before ever seeing a blank line", async () => {
    const proxy = await startProxy({ maxHeaderBytes: 64 });
    try {
      const client = rawConnect(proxy.port);
      client.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(200)}\r\n`);
      const response = await readUntil(client, (buf) => buf.includes("\r\n\r\n"));
      assert.match(response, /^HTTP\/1\.1 400/);
    } finally {
      proxy.server.close();
    }
  });

  it("does NOT count pipelined tunnel payload against the header-size limit", async () => {
    // A valid CONNECT whose header is well under the limit, followed by a large
    // pipelined payload (a big TLS ClientHello) that alone exceeds the limit,
    // must tunnel — the limit bounds the header, not the forwarded payload.
    const upstream = await startFakeUpstream();
    const proxy = await startProxy({
      approved: { host: "127.0.0.1", port: upstream.port },
      maxHeaderBytes: 64,
    });
    try {
      const client = rawConnect(proxy.port);
      const bigPayload = "z".repeat(4_096); // >> maxHeaderBytes (64)
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n\r\n${bigPayload}`);
      const all = await readUntil(client, (buf) => buf.includes("echo:"));
      assert.match(all, /^HTTP\/1\.1 200/);
      assert.equal(all.includes(`echo:${bigPayload}`), true);
      client.destroy();
    } finally {
      proxy.server.close();
      upstream.server.close();
    }
  });

  it("tears down a slow-loris client that never completes the CONNECT header (408)", async () => {
    let dialed = false;
    const proxy = await startProxy({
      headerTimeoutMs: 100,
      connectUpstream: async () => {
        dialed = true;
        throw new Error("must never be called");
      },
    });
    try {
      const client = rawConnect(proxy.port);
      // Send a partial header and then nothing — no blank-line terminator ever.
      client.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n");
      const response = await readUntil(client, (buf) => buf.includes("\r\n\r\n"), 2_000);
      assert.match(response, /^HTTP\/1\.1 408/);
      assert.equal(dialed, false);
    } finally {
      proxy.server.close();
    }
  });

  it("responds 502 when the upstream connection fails, without leaking a tunnel", async () => {
    const proxy = await startProxy({
      approved: { host: "api.anthropic.com", port: 443 },
      connectUpstream: async () => {
        throw new Error("upstream unreachable");
      },
    });
    try {
      const client = rawConnect(proxy.port);
      client.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
      const response = await readUntil(client, (buf) => buf.includes("\r\n\r\n"));
      assert.match(response, /^HTTP\/1\.1 502/);
    } finally {
      proxy.server.close();
    }
  });
});
