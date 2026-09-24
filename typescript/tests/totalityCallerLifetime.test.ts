import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  bindCallerDisconnect,
  signalForWork,
  TotalityCallerDisconnected,
  type CallerResponse,
} from "../src/totality/callerLifetime.js";

function response(): CallerResponse & EventEmitter {
  const emitter = new EventEmitter() as CallerResponse & EventEmitter;
  emitter.writableEnded = false;
  emitter.writableFinished = false;
  return emitter;
}

describe("Totality caller lifetime", () => {
  it("aborts request-bound work when the response closes unfinished", () => {
    const reply = response();
    const signal = bindCallerDisconnect(reply);
    reply.emit("close");
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof TotalityCallerDisconnected);
  });

  it("does not abort work after the response has finished", () => {
    const reply = response();
    const signal = bindCallerDisconnect(reply);
    reply.writableFinished = true;
    reply.emit("close");
    assert.equal(signal.aborted, false);
  });

  it("aborts immediately when the response is already destroyed", () => {
    const reply = response();
    reply.destroyed = true;
    const signal = bindCallerDisconnect(reply);
    assert.equal(signal.aborted, true);
  });

  it("keeps durable work off the caller signal", () => {
    const caller = new AbortController();
    assert.equal(signalForWork("durable", caller.signal), undefined);
    assert.equal(signalForWork("request-bound", caller.signal), caller.signal);
    caller.abort();
    assert.equal(signalForWork("durable", caller.signal), undefined);
    assert.equal(signalForWork("request-bound", caller.signal)?.aborted, true);
  });
});
