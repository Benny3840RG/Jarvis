import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { Server } from "node:http";
import { test } from "node:test";
import { castAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

async function boundedOutcome(sending: Promise<void>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sending.then(
        () => "success",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Cast cancellation closes a stalled routing socket", async (t) => {
  const abort = new AbortController();
  let closed = false;
  class StalledSocket extends EventEmitter {
    connect(): void {
      abort.abort(new Error("route-abort"));
    }
    close(): void {
      closed = true;
    }
  }
  t.mock.method(dgram, "createSocket", () => new StalledSocket());
  const sending = castAnnouncement("127.0.0.1", "Test.", 0.12, abort.signal);
  assert.equal(await boundedOutcome(sending), "rejected");
  assert.equal(closed, true);
});

test("Cast cancellation bounds an audio listener whose callback stalls", async (t) => {
  const abort = new AbortController();
  let listenCalled = false;
  t.mock.method(Server.prototype, "listen", function (this: Server) {
    listenCalled = true;
    abort.abort(new Error("listen-abort"));
    return this;
  });
  const sending = castAnnouncement("127.0.0.1", "Test.", 0.12, abort.signal);
  assert.equal(await boundedOutcome(sending), "rejected");
  assert.equal(listenCalled, true);
});
