import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Server } from "node:http";
import { test, type TestContext } from "node:test";
import castv2Client from "castv2-client";
import { castAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

type Callback = (error: Error | null, value?: unknown) => void;
class FakeClient extends EventEmitter {
  calls: string[] = [];
  mode = "success";
  player = new EventEmitter();
  connect(_address: string, callback: () => void): void {
    callback();
  }
  close(): void {
    this.calls.push("close");
  }
  getVolume(callback: Callback): void {
    this.calls.push("getVolume");
    if (this.mode !== "stalled-volume") callback(null, { level: 0.2, muted: false });
  }
  setVolume(_volume: unknown, callback: Callback): void {
    this.calls.push("setVolume");
    if (!(
      this.mode === "stalled-restore" && this.calls.filter((x) => x === "setVolume").length > 1
    ))
      callback(null);
  }
  stop(_player: unknown, callback: Callback): void {
    this.calls.push("stop");
    callback(null);
  }
  launch(_receiver: unknown, callback: Callback): void {
    this.calls.push("launch");
    const player = Object.assign(this.player, {
      load: (media: { contentId: string }, _options: unknown, done: Callback) => {
        this.calls.push("load");
        if (this.mode === "initial-idle") player.emit("status", { playerState: "IDLE" });
        void fetch(media.contentId)
          .then(async (response) => {
            await response.arrayBuffer();
            done(null, { playerState: "PLAYING" });
            player.emit("status", { playerState: "PLAYING" });
            setTimeout(
              () =>
                player.emit("status", {
                  playerState: "IDLE",
                  idleReason: this.mode === "playback-error" ? "ERROR" : "FINISHED",
                }),
              5,
            );
          })
          .catch((error: Error) => done(error));
      },
    });
    callback(null, player);
  }
}
function fixture(t: TestContext, mode: string) {
  const client = new FakeClient();
  client.mode = mode;
  const servers: Server[] = [];
  t.mock.method(castv2Client as { Client: new () => FakeClient }, "Client", function () {
    return client;
  });
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    servers.push(this);
    return Reflect.apply(listen, this, args) as Server;
  });
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  return { client, servers };
}

test("Cast abort bounds a stalled volume callback and closes the audio server", async (t) => {
  const { client, servers } = fixture(t, "stalled-volume");
  const sending = castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(400));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      sending.then(
        () => "success",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 2000);
      }),
    ]);
    assert.equal(outcome, "rejected");
    assert.ok(servers.every((server) => !server.listening));
    assert.ok(!client.calls.includes("launch"));
  } finally {
    clearTimeout(timer);
  }
});

test("Cast IDLE with ERROR is not successful playback", async (t) => {
  fixture(t, "playback-error");
  await assert.rejects(castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(2500)));
});

test("Cast cleanup is bounded when volume restoration never acknowledges", async (t) => {
  const { servers } = fixture(t, "stalled-restore");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sending = castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(800));
  try {
    const outcome = await Promise.race([
      sending.then(
        () => "success",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 2000);
      }),
    ]);
    assert.notEqual(outcome, "hung");
    assert.ok(servers.every((server) => !server.listening));
  } finally {
    clearTimeout(timer);
  }
});

test("Cast success requires fetched audio and finished playback, then closes resources", async (t) => {
  const { client, servers } = fixture(t, "success");
  await castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(2500));
  assert.ok(client.calls.includes("load"));
  assert.ok(client.calls.includes("close"));
  assert.ok(servers.every((server) => !server.listening));
  assert.equal(client.player.listenerCount("status"), 0);
});

test("Cast ignores an initial IDLE without an idle reason", async (t) => {
  fixture(t, "initial-idle");
  await castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(2500));
});
