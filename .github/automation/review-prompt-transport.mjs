import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 200_000;
const CHUNK_BYTES = 48_000;
export const PROMPT_CHUNKS = 6;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function encodePrompt(prompt) {
  const bytes = Buffer.from(prompt, "utf8");
  if (bytes.length > MAX_BYTES)
    throw new Error("Review prompt exceeds transport bound.");
  const encoded = bytes.toString("base64");
  return {
    chunks: Array.from({ length: PROMPT_CHUNKS }, (_, i) =>
      encoded.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
    ),
    digest: digest(bytes),
  };
}

export function decodePrompt(chunks, expectedDigest) {
  if (
    chunks.length !== PROMPT_CHUNKS ||
    chunks.some((c) => typeof c !== "string" || c.length > CHUNK_BYTES)
  )
    throw new Error("Invalid review prompt chunks.");
  const encoded = chunks.join("");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length > MAX_BYTES ||
    bytes.toString("base64") !== encoded ||
    digest(bytes) !== expectedDigest
  )
    throw new Error("Incomplete or changed review prompt transport.");
  return bytes.toString("utf8");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const prompt = decodePrompt(
    Array.from(
      { length: PROMPT_CHUNKS },
      (_, i) => process.env[`PROMPT_CHUNK_${i}`] || "",
    ),
    process.env.PROMPT_DIGEST,
  );
  if (!prompt || !process.argv[2])
    throw new Error("Complete review prompt and destination required.");
  writeFileSync(process.argv[2], prompt, { mode: 0o644, flag: "wx" });
}
