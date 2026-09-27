import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import workerThreads from "node:worker_threads";
import { test } from "node:test";
import { synthesizeAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

test("synthesis cancels and terminates a nonresponsive worker", async (t) => {
  let created = false;
  let terminated = false;
  class StalledWorker extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    constructor(_url: unknown, options: { env: unknown; execArgv: unknown }) {
      super();
      created = true;
      assert.deepEqual(options.env, {});
      assert.deepEqual(options.execArgv, []);
    }
    async terminate(): Promise<number> {
      terminated = true;
      return 1;
    }
  }
  t.mock.method(
    workerThreads,
    "Worker",
    function (url: unknown, options: { env: unknown; execArgv: unknown }) {
      return new StalledWorker(url, options);
    },
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test-abort")), 30);
  try {
    await assert.rejects(synthesizeAnnouncement("Test.", "en-au", controller.signal));
    assert.equal(created, true);
    assert.equal(terminated, true);
  } finally {
    clearTimeout(timer);
  }
});
