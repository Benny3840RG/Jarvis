import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderDangerPage } from "../src/settings/credentialsPage.js";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

describe("settings shell", () => {
  it("keeps one Settings rail and four tabs", () => {
    const rails = [...widget.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(rails, [
      "focus",
      "board",
      "reminders",
      "operations",
      "livework",
      "systems",
      "settings",
    ]);
    assert.equal(rails.filter((rail) => rail === "settings").length, 1);
    const tabs = [...widget.matchAll(/data-settings-tab="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(tabs, ["general", "credentials", "persistence", "danger"]);
    assert.match(widget, /<a [^>]*href="#view-general"/);
    assert.match(widget, /<a [^>]*href="#view-credentials"/);
    assert.match(widget, /<a [^>]*href="#view-persistence"/);
    assert.match(widget, /<a [^>]*href="#view-danger"/);
    assert.doesNotMatch(widget, /<button[^>]*data-settings-tab/);
    assert.match(widget, /id="view-settings"/);
    assert.match(widget, /id="console-motion"/);
    assert.match(widget, /Reduce motion/);
    assert.match(widget, /prefers-reduced-motion:\s*reduce/);
    assert.match(widget, /min-height:\s*44px/);
    assert.match(widget, /font-size:\s*14px;\s*font-weight:\s*600/);
    assert.match(widget, /font-size:\s*16px/);
    assert.match(widget, /fp-chip/);
    assert.match(widget, /\.cred-card h3 \{[^}]*font-size:\s*16px/);
    assert.match(widget, /\.cred-card p, \.cred-card li \{[^}]*font-size:\s*12px/);
    assert.match(widget, /\.settings-shell \.settings-dl dt \{ font-size: 12px; \}/);
    assert.match(widget, /href="\/settings\/danger"/);
    assert.doesNotMatch(widget, /sessionStorage|END OVERLAP|openEnd\(/);
    assert.doesNotMatch(widget, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
  });

  it("serves a danger page that does not remove tokens", () => {
    const html = renderDangerPage();
    assert.match(html, /Danger zone/);
    assert.match(html, /id="service"/);
    assert.match(html, /id="approval"/);
    assert.match(html, /id="delivery"/);
    assert.match(html, /href="\/settings\/credentials#settings-general"/);
    assert.match(html, /href="\/settings\/credentials"/);
    assert.doesNotMatch(html, /<form|<span class="tab">/);
    assert.match(html, /Not verified/);
    assert.match(html, /Guarding does not add an End button/);
    assert.doesNotMatch(html, /<button[^>]*>\s*End\b/);
    assert.match(html, /Convex wipe is not part of this phase/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /font-size:14px; font-weight:600/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.doesNotMatch(html, /END OVERLAP|env remove|sessionStorage|serviceDigests|[0-9a-f]{64}/);
    assert.doesNotMatch(html, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
  });
});
