import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

function generalSection(): string {
  const start = widget.indexOf('id="view-general"');
  const end = widget.indexOf('<aside class="right-rail">');
  assert.ok(start !== -1 && end > start, "Settings → General view was not found");
  return widget.slice(start, end);
}

function displayPreferencesApi(): {
  keys: { theme: string; contrast: string; motion: string };
  defaults: { theme: string; contrast: string; motion: string };
  read: (storage: { getItem(key: string): string | null }) => {
    theme: string;
    contrast: string;
    motion: string;
  };
  write: (
    storage: { setItem(key: string, value: string): void },
    preferences: { theme: string; contrast: string; motion: string },
  ) => boolean;
  apply: (
    preferences: { theme: string; contrast: string; motion: string },
    root: { dataset: Record<string, string> },
  ) => void;
} {
  const start = widget.indexOf("// BEGIN console display preferences");
  const end = widget.indexOf("// END console display preferences");
  assert.ok(start !== -1 && end > start, "console display preference block was not found");
  const source = `${widget.slice(start, end)}\nconsoleDisplayPreferences;`;
  return new Script(source).runInNewContext({}) as ReturnType<typeof displayPreferencesApi>;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (items.has(key) ? items.get(key)! : null),
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    items,
  };
}

describe("Settings → General console", () => {
  it("shows timezone status and display controls without profile or home defaults", () => {
    const section = generalSection();
    assert.match(section, /<h2 id="general-heading">General<\/h2>/);
    assert.match(section, /id="tz-effective"/);
    assert.match(section, /id="timezone-banner"/);
    assert.match(section, /Edit in \.env\.local/);
    assert.match(section, /Reminder due model docs/);
    assert.match(section, /Save display preferences/);
    assert.match(section, /Does not change CLI output/);
    assert.match(section, /does not authorise ToolActions or record ΩΣ completion/);
    assert.match(section, /name="console-theme" value="system"/);
    assert.match(section, /name="console-theme" value="light"/);
    assert.match(section, /name="console-theme" value="dark"/);
    assert.match(section, /Increase contrast/);
    assert.match(section, /Reduce motion/);
    assert.doesNotMatch(section, /Australia\/Melbourne/);
    assert.doesNotMatch(section, /Console home|Default view|email|avatar|Profile|Account/i);
    assert.match(widget, /get_general_settings/);
    assert.doesNotMatch(widget, /addEventListener\("change"[^;]*writeConsoleDisplayPreferences/);
  });

  it("persists namespaced display preferences across a reload and rejects invalid values", () => {
    const api = displayPreferencesApi();
    assert.equal(api.keys.theme, "console.theme");
    assert.equal(api.keys.contrast, "console.contrast");
    assert.equal(api.keys.motion, "console.motion");
    const storage = memoryStorage();
    assert.equal(JSON.stringify(api.read(storage)), JSON.stringify(api.defaults));

    assert.equal(
      api.write(storage, { theme: "dark", contrast: "increase", motion: "reduce" }),
      true,
    );
    const reloaded = memoryStorage(Object.fromEntries(storage.items));
    assert.equal(
      JSON.stringify(api.read(reloaded)),
      JSON.stringify({ theme: "dark", contrast: "increase", motion: "reduce" }),
    );

    const root = { dataset: {} as Record<string, string> };
    api.apply(api.read(reloaded), root);
    assert.deepEqual(root.dataset, {
      consoleTheme: "dark",
      consoleContrast: "increase",
      consoleMotion: "reduce",
    });

    storage.setItem(api.keys.theme, "neon");
    assert.equal(api.read(storage).theme, "system");
    assert.equal(
      api.write(storage, { theme: "neon", contrast: "increase", motion: "reduce" }),
      false,
    );
    assert.equal(storage.items.get(api.keys.theme), "neon");
    assert.equal(storage.items.get(api.keys.contrast), "increase");
  });
});
