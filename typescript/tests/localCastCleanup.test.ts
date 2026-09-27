import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Server } from "node:http";
import { test } from "node:test";
import castv2Client from "castv2-client";
import { castAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

class RefusedClient extends EventEmitter {
  closed = false;
  connect(_address: string, _callback: () => void): void {
    queueMicrotask(() => this.emit("error", new Error("connection-refused")));
  }
  close(): void {
    this.closed = true;
  }
}

test("Cast connection failure closes both the audio server and client", async (t) => {
  const servers: Server[] = [];
  const client = new RefusedClient();
  const module = castv2Client as { Client: new () => RefusedClient };
  t.mock.method(module, "Client", function () {
    return client;
  });
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    servers.push(this);
    return Reflect.apply(listen, this, args) as Server;
  });
  try {
    await assert.rejects(castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(1000)));
    assert.ok(servers.length > 0, "test must exercise a real audio server");
    assert.ok(
      servers.every((server) => !server.listening),
      "audio server leaked after connect failure",
    );
    assert.equal(client.closed, true, "failed Cast client was not closed");
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
