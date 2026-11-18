import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { HUD_DIR, bundleHud } from "../src/mcp/hud/bundle.mjs";

function scratchHud(template: string, files: Record<string, string> = {}): URL {
  const root = mkdtempSync(join(tmpdir(), "hud-bundle-"));
  mkdirSync(join(root, "hud", "styles"), { recursive: true });
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "dot.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(join(root, "hud", "dashboard-v1.template.html"), template);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, "hud", path), body);
  return pathToFileURL(join(root, "hud") + "/");
}

describe("HUD assembly", () => {
  const html = bundleHud();

  it("assembles one self-contained page with every piece inlined", () => {
    assert.match(html, /^<!doctype html>/i);
    assert.equal(html.includes("<!--hud:include"), false);
    assert.equal(html.includes("{{hud-asset:"), false);
    assert.equal(html.match(/<style\b/gi)?.length, 8);
    assert.equal(html.match(/<script\b[^>]*>/gi)?.length, 1);
    assert.match(html, /data:font\/woff2;base64,d09GMg/, "Rajdhani fonts are inlined");
    assert.match(html, /data:image\/jpeg;base64,\/9j\//, "the backdrop photo is inlined");
    assert.doesNotMatch(
      html,
      /<(?:script|link|img)\b[^>]*\b(?:src|href)="https?:/i,
      "no remote resources",
    );
  });

  it("keeps every source piece small enough for the automated reviewer", () => {
    const pieces = [
      "dashboard-v1.template.html",
      "script.js",
      ...readdirSync(new URL("styles/", HUD_DIR)).map((name) => `styles/${name}`),
    ];
    for (const piece of pieces)
      assert.ok(
        statSync(new URL(piece, HUD_DIR)).size <= 160 * 1024,
        `${piece} exceeds 160 KB; split it further`,
      );
  });

  it("joins includes and assets byte for byte", () => {
    const dir = scratchHud(
      "<style><!--hud:include styles/01-base.css--></style><script><!--hud:include script.js--></script>",
      {
        "styles/01-base.css":
          "a{background:url(data:image/jpeg;base64,{{hud-asset:../assets/dot.jpg}})}",
        "script.js": "const price = '$1 $& $$';",
      },
    );
    assert.equal(
      bundleHud(dir),
      "<style>a{background:url(data:image/jpeg;base64,/9j/)}</style><script>const price = '$1 $& $$';</script>",
    );
    rmSync(new URL("../", dir), { recursive: true, force: true });
  });

  it("fails closed on an invalid, missing or unresolved marker", () => {
    for (const [template, files, message] of [
      ["<!--hud:include ../secret.txt-->", {}, /Invalid HUD include path/],
      ["<!--hud:include styles/09-missing.css-->", {}, /ENOENT/],
      ["{{hud-asset:/etc/passwd}}", {}, /Invalid HUD asset path/],
      [
        "<!--hud:include script.js-->",
        { "script.js": "<!--hud:include script.js-->" },
        /Unresolved HUD marker/,
      ],
    ] as const) {
      const dir = scratchHud(template, files);
      assert.throws(() => bundleHud(dir), message);
      rmSync(new URL("../", dir), { recursive: true, force: true });
    }
  });
});
