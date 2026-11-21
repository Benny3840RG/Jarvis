import { readFileSync } from "node:fs";

/**
 * Assembles the HUD page from its source pieces.
 *
 * The HUD must be served as one self-contained HTML document: the MCP server
 * publishes it as a single `ui://` resource, and the HTTP HUD's CSP allows only
 * inline styles, inline script and `data:` fonts/images. The source is kept in
 * small files instead (see README.md in this folder) and joined here, at load
 * time, into exactly that document:
 *
 * - `<!--hud:include styles/NN-name.css-->` and `<!--hud:include script.js-->`
 *   in `dashboard-v1.template.html` are replaced by that file's text;
 * - `{{hud-asset:../assets/name.ext}}` in any piece is replaced by the file's
 *   bytes in base64 (for `data:` URLs).
 *
 * Fails closed: an unknown, missing or unresolved marker throws.
 */
const INCLUDE = /<!--hud:include ([^>]*?)-->/g;
const ASSET = /\{\{hud-asset:([^}]*)\}\}/g;
const INCLUDE_PATH = /^(?:styles\/[0-9]{2}-[a-z0-9-]+\.css|script\.js)$/;
const ASSET_PATH = /^\.\.\/assets\/[A-Za-z0-9-]+\.(?:jpg|woff2)$/;

export const HUD_DIR = new URL("./", import.meta.url);

export function bundleHud(dir = HUD_DIR) {
  const read = (path) => readFileSync(new URL(path, dir), "utf8");
  const assets = (text) =>
    text.replace(ASSET, (_, path) => {
      if (!ASSET_PATH.test(path)) throw new Error(`Invalid HUD asset path: ${path}`);
      return readFileSync(new URL(path, dir)).toString("base64");
    });
  const html = read("dashboard-v1.template.html").replace(INCLUDE, (_, path) => {
    if (!INCLUDE_PATH.test(path)) throw new Error(`Invalid HUD include path: ${path}`);
    return assets(read(path));
  });
  const result = assets(html);
  if (result.includes("<!--hud:include") || result.includes("{{hud-asset:"))
    throw new Error("Unresolved HUD marker after assembly.");
  return result;
}
