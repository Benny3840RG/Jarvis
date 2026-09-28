import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import workerThreads from "node:worker_threads";
import { describe, it } from "node:test";

import {
  LocalCastTransportError,
  synthesizeAnnouncement,
} from "../src/integrations/googleHome/localCastTransport.js";
import { assertAudibleWav, assessWav } from "../src/integrations/googleHome/wavAudibility.js";

const ANNOUNCEMENT =
  "Tayah... are you there? Can you hear me? I'm Nolan. Your naming contribution has been permanently recorded. Unfortunately. They see me Nolan...";

function wav16(samples: readonly number[], sampleRate = 22050): Uint8Array {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

const silence = (count = 4000) => wav16(new Array<number>(count).fill(0));
const tone = (count = 4000) =>
  wav16(Array.from({ length: count }, (_, i) => Math.round(12000 * Math.sin(i / 5))));

describe("assessWav", () => {
  it("classifies an all-zero clip as silent", () => {
    assert.equal(assessWav(silence()).status, "silent");
  });

  it("classifies a clip of near-zero noise as silent", () => {
    const noise = wav16(Array.from({ length: 4000 }, (_, i) => (i % 3) - 1));
    assert.equal(assessWav(noise).status, "silent");
  });

  it("classifies a normal speech-level clip as audible", () => {
    const result = assessWav(tone());
    assert.equal(result.status, "audible");
    assert.ok(result.peak > 0.2);
  });

  it("treats malformed or unsupported audio as invalid, never audible", () => {
    assert.equal(assessWav(new Uint8Array(10)).status, "invalid");
    const notRiff = tone();
    notRiff[0] = 0x58;
    assert.equal(assessWav(notRiff).status, "invalid");
    const eightBit = Buffer.from(tone());
    eightBit.writeUInt16LE(8, 34);
    assert.equal(assessWav(new Uint8Array(eightBit)).status, "invalid");
    const noData = Buffer.from(tone());
    noData.write("junk", 36, "ascii");
    assert.equal(assessWav(new Uint8Array(noData)).status, "invalid");
  });

  it("does not trust a data length that overruns the buffer", () => {
    const lying = Buffer.from(tone());
    lying.writeUInt32LE(0x7fffffff, 40);
    assert.equal(assessWav(new Uint8Array(lying)).status, "invalid");
  });

  it("rejects 16-bit data with an incomplete sample", () => {
    const unaligned = Buffer.from(tone());
    unaligned.writeUInt32LE(unaligned.length - 45, 40);
    assert.equal(assessWav(new Uint8Array(unaligned)).status, "invalid");
  });

  it("rejects data without a complete frame for every channel", () => {
    const unaligned = Buffer.from(tone());
    unaligned.writeUInt16LE(2, 22);
    unaligned.writeUInt32LE(22050 * 4, 28);
    unaligned.writeUInt16LE(4, 32);
    unaligned.writeUInt32LE(unaligned.length - 46, 40);
    assert.equal(assessWav(new Uint8Array(unaligned)).status, "invalid");
  });

  it("rejects RIFF extents that do not match the supplied file", () => {
    const tooShort = Buffer.from(tone());
    tooShort.writeUInt32LE(tooShort.length - 9, 4);
    assert.equal(assessWav(new Uint8Array(tooShort)).status, "invalid");

    const tooLong = Buffer.from(tone());
    tooLong.writeUInt32LE(tooLong.length - 7, 4);
    assert.equal(assessWav(new Uint8Array(tooLong)).status, "invalid");
  });

  it("rejects bytes after the supported PCM data chunk", () => {
    const trailing = Buffer.concat([Buffer.from(tone()), Buffer.from("trailing")]);
    trailing.writeUInt32LE(trailing.length - 8, 4);
    assert.equal(assessWav(new Uint8Array(trailing)).status, "invalid");
  });

  it("rejects PCM headers with inconsistent frame and byte rates", () => {
    const badBlockAlign = Buffer.from(tone());
    badBlockAlign.writeUInt16LE(1, 32);
    assert.equal(assessWav(new Uint8Array(badBlockAlign)).status, "invalid");

    const badByteRate = Buffer.from(tone());
    badByteRate.writeUInt32LE(22050, 28);
    assert.equal(assessWav(new Uint8Array(badByteRate)).status, "invalid");
  });
});

describe("assertAudibleWav", () => {
  it("throws local-tts-silent-audio for silence and local-tts-invalid-audio for junk", () => {
    assert.throws(() => assertAudibleWav(silence()), /local-tts-silent-audio/);
    assert.throws(() => assertAudibleWav(new Uint8Array(10)), /local-tts-invalid-audio/);
    assert.doesNotThrow(() => assertAudibleWav(tone()));
  });
});

describe("synthesizeAnnouncement audibility", () => {
  function mockWorker(t: { mock: { method: (...args: never[]) => unknown } }, audio: Uint8Array) {
    class FakeWorker extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      constructor() {
        super();
        setImmediate(() => this.emit("message", audio));
      }
      async terminate(): Promise<number> {
        return 0;
      }
    }
    (t.mock.method as (target: unknown, name: string, impl: unknown) => unknown)(
      workerThreads,
      "Worker",
      function () {
        return new FakeWorker();
      },
    );
  }

  it("fails closed when the worker returns silence, before anything can be sent", async (t) => {
    mockWorker(t, silence());
    await assert.rejects(
      synthesizeAnnouncement("Test."),
      (error: unknown) =>
        error instanceof LocalCastTransportError &&
        error.message === "local-tts-failed" &&
        error.cause instanceof Error &&
        error.cause.message === "local-tts-silent-audio",
    );
  });

  it("still returns audible audio from the worker", async (t) => {
    const audio = tone();
    mockWorker(t, audio);
    assert.deepEqual(await synthesizeAnnouncement("Test."), audio);
  });

  it("produces audible speech for the real announcement with the real worker", async () => {
    const audio = await synthesizeAnnouncement(ANNOUNCEMENT, "en-au");
    const result = assessWav(audio);
    assert.equal(result.status, "audible");
    assert.ok(result.peak > 0.2, `peak ${result.peak} is too quiet for speech`);
    assert.ok(result.durationSeconds > 5, "the full announcement should run several seconds");
  });
});
