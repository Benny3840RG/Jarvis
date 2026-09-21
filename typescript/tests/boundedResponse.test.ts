import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
  readBoundedResponseText,
} from "../src/integrations/boundedResponse.js";

function streamedResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, { headers }), wasCancelled: () => cancelled };
}

describe("readBoundedResponseText", () => {
  it("accepts an exact byte limit and releases its reader", async () => {
    const { response } = streamedResponse([Buffer.from("abc"), Buffer.from("def")]);
    assert.equal(await readBoundedResponseText(response, { maxBytes: 6 }), "abcdef");
    assert.equal(response.body?.locked, false);
  });

  it("decodes multibyte text split across chunks without charging characters as bytes", async () => {
    const bytes = Buffer.from("€🧠");
    const { response } = streamedResponse([
      bytes.subarray(0, 1),
      bytes.subarray(1, 5),
      bytes.subarray(5),
    ]);
    assert.equal(await readBoundedResponseText(response, { maxBytes: 7 }), "€🧠");
    await assert.rejects(readBoundedResponseText(new Response("€🧠"), { maxBytes: 6 }), /exceeds/);
  });

  for (const contentLength of [undefined, "1", "invalid"]) {
    it(`bounds streamed bytes with Content-Length=${String(contentLength)}`, async () => {
      const { response, wasCancelled } = streamedResponse(
        [Buffer.from("abcd"), Buffer.from("ef")],
        contentLength === undefined ? undefined : { "Content-Length": contentLength },
      );
      await assert.rejects(readBoundedResponseText(response, { maxBytes: 5 }), /exceeds/);
      assert.equal(wasCancelled(), true);
      assert.equal(response.body?.locked, false);
    });
  }

  it("enforces the default cap on an unannounced response", async () => {
    assert.equal(DEFAULT_PROVIDER_RESPONSE_MAX_BYTES, 1_048_576);
    const { response, wasCancelled } = streamedResponse([
      new Uint8Array(DEFAULT_PROVIDER_RESPONSE_MAX_BYTES + 1),
    ]);
    await assert.rejects(readBoundedResponseText(response), /exceeds/);
    assert.equal(wasCancelled(), true);
  });

  it("rejects declared oversized bodies before pulling bytes", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            pulls += 1;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "Content-Length": "999999999999999999999999999999999" } },
    );
    await assert.rejects(readBoundedResponseText(response, { maxBytes: 5 }), /exceeds/);
    assert.equal(pulls, 0);
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  });

  it("returns empty text for absent bodies without calling an unbounded fallback", async () => {
    const response = new Response(null, { status: 204 });
    response.text = () => {
      throw new Error("Unbounded fallback called");
    };
    assert.equal(await readBoundedResponseText(response, { maxBytes: 0 }), "");
    assert.equal(await readBoundedResponseText(new Response(""), { maxBytes: 0 }), "");
  });

  it("fails promptly when overflow cancellation never settles", { timeout: 1_000 }, async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("oversized"));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    await assert.rejects(readBoundedResponseText(response, { maxBytes: 1 }), /exceeds/);
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  });

  it(
    "aborts stalled reads, preserves the timeout reason and releases the reader",
    { timeout: 1_000 },
    async () => {
      const controller = new AbortController();
      const reason = new Error("provider timed out");
      reason.name = "AbortError";
      let cancellationReason: unknown;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel(error) {
            cancellationReason = error;
            return new Promise<void>(() => {});
          },
        }),
      );
      const reading = readBoundedResponseText(response, { signal: controller.signal });
      const rejected = assert.rejects(reading, (error) => error === reason);
      controller.abort(reason);
      await rejected;
      assert.equal(cancellationReason, reason);
      assert.equal(response.body?.locked, false);
    },
  );

  it("cancels without pulling for an already-aborted signal", async () => {
    const reason = new Error("cancelled");
    const { response, wasCancelled } = streamedResponse([Buffer.from("body")]);
    await assert.rejects(
      readBoundedResponseText(response, { signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(wasCancelled(), true);
    assert.equal(response.body?.locked, false);
  });

  it("releases its reader after a stream read fails", async () => {
    const failure = new Error("broken body");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(failure);
        },
      }),
    );
    await assert.rejects(readBoundedResponseText(response), (error) => error === failure);
    assert.equal(response.body?.locked, false);
  });

  it("rejects invalid byte limits", async () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(readBoundedResponseText(new Response(null), { maxBytes }), RangeError);
    }
  });
});
