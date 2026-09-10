import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { encodePrompt, decodePrompt } from "./review-prompt-transport.mjs";

test("maximum review context survives bounded environment transport without argument-size failure", () => {
  const prompt = "😀".repeat(50_000);
  const encoded = encodePrompt(prompt);
  assert.equal(decodePrompt(encoded.chunks, encoded.digest), prompt);
  const env = Object.fromEntries(
    encoded.chunks.map((chunk, i) => [`PROMPT_CHUNK_${i}`, chunk]),
  );
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
});

test("missing, changed, oversized or noncanonical prompt data is rejected rather than truncated", () => {
  const encoded = encodePrompt("x".repeat(150_000));
  assert.throws(() => decodePrompt(encoded.chunks.slice(1), encoded.digest));
  assert.throws(() =>
    decodePrompt(["", ...encoded.chunks.slice(1)], encoded.digest),
  );
  assert.throws(() => decodePrompt(encoded.chunks, "0".repeat(64)));
  assert.throws(() =>
    decodePrompt(["!", ...encoded.chunks.slice(1)], encoded.digest),
  );
  assert.throws(() => encodePrompt("x".repeat(200_001)));
});
