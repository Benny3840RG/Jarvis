import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import castv2Client from "castv2-client";
import { castAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

class IdleClient extends EventEmitter {
  connect(_address: string, callback: () => void): void {
    callback();
  }
  getVolume(): void {
    /* Deliberately stalled receiver response. */
  }
  close(): void {
    /* No real Cast connection in this fixture. */
  }
}

test("Cast cancellation destroys an accepted incomplete HTTP connection", async (t) => {
  const abort = new AbortController();
  const servers: Server[] = [];
  let peer: Socket | undefined;
  let accepted: Socket | undefined;
  t.mock.method(castv2Client as { Client: new () => IdleClient }, "Client", function () {
    return new IdleClient();
  });
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    servers.push(this);
    this.once("connection", (socket: Socket) => {
      accepted = socket;
    });
    this.once("listening", () => {
      const bound = this.address();
      assert.ok(bound && typeof bound !== "string");
      peer = connect(bound.port, "127.0.0.1", () => {
        peer!.write("GET / HTTP/1.1\r\n");
        setImmediate(() => abort.abort(new Error("test-cancel")));
      });
      peer.on("error", () => undefined);
    });
    return Reflect.apply(listen, this, args) as Server;
  });
  const timeout = setTimeout(() => abort.abort(new Error("test-deadline")), 3000);
  try {
    await assert.rejects(castAnnouncement("127.0.0.1", "Test.", 0.12, abort.signal));
    assert.ok(accepted, "fixture must hold a real accepted connection");
    assert.equal(accepted.destroyed, true, "accepted HTTP connection leaked after listener abort");
  } finally {
    clearTimeout(timeout);
    peer?.destroy();
    accepted?.destroy();
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
