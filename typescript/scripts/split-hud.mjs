/**
 * Splits a single-file HUD (the old src/mcp/dashboard-v1.html) into the source
 * pieces under src/mcp/hud/ and proves the split is lossless: it writes nothing
 * unless bundleHud() over the new pieces reproduces the input byte for byte.
 *
 *   node scripts/split-hud.mjs <monolith.html>
 *
 * Re-runnable: to bring in a branch that still edits the old single file, run
 * it on that branch's version of the file (git show <sha>:typescript/src/mcp/dashboard-v1.html).
 */
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleHud } from "../src/mcp/hud/bundle.mjs";

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/split-hud.mjs <monolith.html>");
  process.exit(2);
}
const source = readFileSync(input, "utf8");
const hudDir = new URL("../src/mcp/hud/", import.meta.url);
const assetsDir = new URL("../src/mcp/assets/", import.meta.url);

for (const marker of ["<!--hud:include", "{{hud-asset:"])
  if (source.includes(marker)) throw new Error(`Input already contains ${marker}`);

const slug = (attrs, index) => {
  const id = /\bid="([a-z0-9-]+)"/.exec(attrs)?.[1] ?? (index === 0 ? "base" : "extra");
  return `${String(index + 1).padStart(2, "0")}-${id}`;
};

const pieces = new Map();
const assets = new Map();
let styleIndex = 0;
let template = source.replace(
  /(<style\b([^>]*)>)([\s\S]*?)(<\/style\s*>)/gi,
  (_, open, attrs, body, close) => {
    const path = `styles/${slug(attrs, styleIndex++)}.css`;
    pieces.set(path, body);
    return `${open}<!--hud:include ${path}-->${close}`;
  },
);
// Match tags case-insensitively and with any attributes, so an unexpected tag
// is counted and refused rather than silently left out of the split.
const scriptTags = template.match(/<script\b[^>]*>/gi) ?? [];
if (scriptTags.length !== 1 || scriptTags[0] !== "<script>")
  throw new Error("Expected exactly one inline <script> with no attributes.");
template = template.replace(/(<script>)([\s\S]*?)(<\/script\s*>)/i, (_, open, body, close) => {
  pieces.set("script.js", body);
  return `${open}<!--hud:include script.js-->${close}`;
});

// Large base64 data: URLs in styles become real files under src/mcp/assets/.
const known = new Map(
  readdirSync(assetsDir)
    .filter((name) => /\.(jpg|woff2)$/.test(name))
    .map((name) => [
      createHash("sha256")
        .update(readFileSync(new URL(name, assetsDir)))
        .digest("hex"),
      name,
    ]),
);
for (const [path, body] of pieces) {
  if (!path.startsWith("styles/")) continue;
  pieces.set(
    path,
    body.replace(
      /data:(image\/jpeg|font\/woff2);base64,([A-Za-z0-9+/=]{2000,})/g,
      (match, type, data) => {
        const bytes = Buffer.from(data, "base64");
        if (bytes.toString("base64") !== data) return match; // non-canonical: keep inline
        const digest = createHash("sha256").update(bytes).digest("hex");
        let name = known.get(digest) ?? assets.get(digest)?.name;
        if (!name) {
          const weight = [
            ...body.slice(0, body.indexOf(data)).matchAll(/font-weight:\s*(\d{3})/g),
          ].at(-1)?.[1];
          name =
            type === "font/woff2"
              ? `rajdhani-${weight ?? digest.slice(0, 8)}.woff2`
              : `hud-${digest.slice(0, 8)}.jpg`;
          if (
            [...assets.values()].some((asset) => asset.name === name) ||
            [...known.values()].includes(name)
          )
            throw new Error(`Asset name collision: ${name}`);
          assets.set(digest, { name, bytes });
        }
        return `data:${type};base64,{{hud-asset:../assets/${name}}}`;
      },
    ),
  );
}

// Assemble in a scratch copy first; write the real tree only if it is lossless.
const scratch = mkdtempSync(join(tmpdir(), "hud-split-"));
try {
  const scratchHud = join(scratch, "hud");
  mkdirSync(join(scratchHud, "styles"), { recursive: true });
  cpSync(new URL(".", assetsDir), join(scratch, "assets"), { recursive: true });
  for (const { name, bytes } of assets.values())
    writeFileSync(join(scratch, "assets", name), bytes);
  writeFileSync(join(scratchHud, "dashboard-v1.template.html"), template);
  for (const [path, body] of pieces) writeFileSync(join(scratchHud, path), body);
  const rebuilt = bundleHud(pathToFileURL(scratchHud + "/"));
  if (rebuilt !== source) throw new Error("Split is not lossless; nothing written.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

rmSync(new URL("styles/", hudDir), { recursive: true, force: true });
mkdirSync(new URL("styles/", hudDir), { recursive: true });
for (const { name, bytes } of assets.values()) writeFileSync(new URL(name, assetsDir), bytes);
writeFileSync(new URL("dashboard-v1.template.html", hudDir), template);
for (const [path, body] of pieces) writeFileSync(new URL(path, hudDir), body);
const sha = createHash("sha256").update(source).digest("hex");
console.log(
  `Split ${input} (sha256 ${sha}) into ${pieces.size} pieces and ${assets.size} new assets; lossless.`,
);
