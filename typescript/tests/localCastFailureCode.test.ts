import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Server } from "node:http";
import { test, type TestContext } from "node:test";
import castv2Client from "castv2-client";
import {
  castAnnouncement,
  castErrorCode,
  castIdleReasonCode,
  LocalCastTransportError,
} from "../src/integrations/googleHome/localCastTransport.js";

type Callback = (error: Error | null, value?: unknown) => void;

// A receiver whose load either fetches the hosted audio or ignores it, then
// reports IDLE with the given reason. "launch-error" fails before any load.
class FakeClient extends EventEmitter {
  constructor(
    private readonly mode: "fetch" | "no-fetch" | "launch-error",
    private readonly idleReason: string,
  ) {
    super();
  }
  player = new EventEmitter();
  connect(_address: string, callback: () => void): void {
    callback();
  }
  close(): void {}
  getVolume(callback: Callback): void {
    callback(null, { level: 0.2, muted: false });
  }
  setVolume(_volume: unknown, callback: Callback): void {
    callback(null);
  }
  stop(_player: unknown, callback: Callback): void {
    callback(null);
  }
  launch(_receiver: unknown, callback: Callback): void {
    if (this.mode === "launch-error") {
      callback(new Error("Launch failed for device at 10.0.0.9: busy"));
      return;
    }
    const player = Object.assign(this.player, {
      media: {
        request: (_request: unknown, done: Callback) => done(null),
      },
      load: (media: { contentId: string }, _options: unknown, done: Callback) => {
        const loaded = () => {
          done(null, {
            playerState: "BUFFERING",
            mediaSessionId: 7,
            media: { contentId: media.contentId },
          });
          setTimeout(
            () =>
              player.emit("status", {
                playerState: "IDLE",
                mediaSessionId: 7,
                idleReason: this.idleReason,
              }),
            5,
          );
        };
        if (this.mode === "no-fetch") {
          loaded();
          return;
        }
        void fetch(media.contentId)
          .then(async (response) => {
            await response.arrayBuffer();
            loaded();
          })
          .catch((error: Error) => done(error));
      },
    });
    callback(null, player);
  }
}

function fixture(t: TestContext, client: FakeClient): void {
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
}

async function failureCode(): Promise<string | undefined> {
  try {
    await castAnnouncement("127.0.0.1", "Test.", 0.12, AbortSignal.timeout(4000));
  } catch (error) {
    assert.ok(error instanceof LocalCastTransportError);
    assert.equal(error.message, "cast-announcement-failed");
    return error.providerFailureCode;
  }
  assert.fail("expected the announcement to fail");
}

test("a playback error after the receiver fetched the audio says so", async (t) => {
  fixture(t, new FakeClient("fetch", "ERROR"));
  assert.equal(await failureCode(), "playback:cast-playback-error:audio-fetched");
});

test("a playback error without any audio request says the audio was not requested", async (t) => {
  fixture(t, new FakeClient("no-fetch", "ERROR"));
  assert.equal(await failureCode(), "playback:cast-playback-error:audio-not-requested");
});

test("a library error is classified without echoing its text or address", async (t) => {
  fixture(t, new FakeClient("launch-error", "FINISHED"));
  const code = await failureCode();
  assert.equal(code, "launch:cast-unclassified-error:audio-not-requested");
  assert.doesNotMatch(code ?? "", /10\.0\.0\.9|busy/u);
});

test("receiver idle reasons map to fixed codes and unknown reasons are not echoed", () => {
  assert.equal(castIdleReasonCode("ERROR"), "cast-playback-error");
  assert.equal(castIdleReasonCode("INTERRUPTED"), "cast-playback-interrupted");
  assert.equal(castIdleReasonCode("CANCELLED"), "cast-playback-cancelled");
  assert.equal(castIdleReasonCode("SOMETHING <odd>"), "cast-playback-not-finished");
  assert.equal(castIdleReasonCode(undefined), "cast-playback-not-finished");
});

test("only this module's own codes are taken from an error chain", () => {
  assert.equal(
    castErrorCode(new Error("outer", { cause: new Error("cast-request-timeout") })),
    "cast-request-timeout",
  );
  assert.equal(
    castErrorCode(new Error("ECONNREFUSED 192.168.4.228:8009")),
    "cast-unclassified-error",
  );
  assert.equal(castErrorCode("not an error"), "cast-unclassified-error");
});
