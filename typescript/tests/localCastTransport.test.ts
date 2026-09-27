import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { synthesizeAnnouncement } from "../src/integrations/googleHome/localCastTransport.js";

describe("local Cast announcement transport", () => {
  it("synthesizes a valid WAV locally", async () => {
    const audio = await synthesizeAnnouncement("Nolan bridge test.");
    assert.ok(audio.byteLength > 44);
    assert.equal(Buffer.from(audio.subarray(0, 4)).toString("ascii"), "RIFF");
    assert.equal(Buffer.from(audio.subarray(8, 12)).toString("ascii"), "WAVE");
  });
});
