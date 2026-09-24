import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildDangerZoneModel } from "../src/settings/dangerZone/catalog.js";
import { renderDangerZonePage } from "../src/settings/dangerZone/page.js";

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
    assert.match(widget, /href="\/settings\/danger"/);
    assert.match(widget, /Open Persistence Backup/);
    assert.match(widget, /data-settings-jump="persistence"/);
    assert.doesNotMatch(widget, /sessionStorage|END OVERLAP|openEnd\(/);
    assert.doesNotMatch(widget, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
  });

  it("serves Danger as the only End path", () => {
    const html = renderDangerZonePage(
      buildDangerZoneModel({
        provider: "json",
        facts: {
          serviceOverlap: "off",
          serviceFingerprint: null,
          approvalOverlap: "off",
          approvalFingerprint: null,
          deliveryConfigured: false,
          deliveryOverlap: "off",
          deliveryFingerprint: null,
          lastVerify: "not-run",
        },
        verifiedBackup: null,
        dataDir: "/tmp/jarvis-data",
        credentialsEndOverlapHref: "/settings/danger#end-service-overlap",
      }),
    );
    assert.match(html, /Danger zone/);
    assert.match(html, /id="service"/);
    assert.match(html, /id="approval"/);
    assert.match(html, /id="delivery"/);
    assert.match(html, /href="\/settings\/credentials"/);
    assert.match(html, /href="\/settings\/danger"/);
    assert.match(html, /href="\/settings\/persistence#backup"/);
    assert.match(html, /data-confirm="END OVERLAP"/);
    assert.match(html, /data-confirm="END APPROVAL OVERLAP"/);
    assert.match(html, /data-confirm="END DELIVERY OVERLAP"/);
    assert.match(html, /Convex owner wipe needs a dedicated empty-target design/);
    assert.match(html, /min-height:44px/);
    assert.match(html, /font-size:14px; font-weight:600/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.match(html, /#1c1612/);
    assert.match(html, /#c47b4a/);
    assert.equal(html.split("I skip backup and accept irreversible local loss").length - 1, 1);
    assert.doesNotMatch(html, /sessionStorage|serviceDigests|[0-9a-f]{64}|name="backupMode"/);
    assert.doesNotMatch(html, /#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
  });
});
