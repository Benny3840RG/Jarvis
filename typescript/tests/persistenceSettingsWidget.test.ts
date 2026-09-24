import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const page = readFileSync(new URL("../src/mcp/persistence-settings.html", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

function dialog(id: string): string {
  const match = page.match(new RegExp(`<section\\s[^>]*id="${id}"[\\s\\S]*?</section>`));
  assert.ok(match, `missing dialog ${id}`);
  return match[0];
}

describe("Persistence settings page", () => {
  it("stacks both backup formats and does not offer a provider switch or JSON fallback", () => {
    assert.match(page, /Settings/);
    assert.match(page, /Active provider/);
    assert.match(page, /will not silently fall back/i);
    assert.match(page, /type="radio"[^>]*disabled/);
    assert.match(page, /Partial \/ JSON-only/);
    assert.match(page, /notesAndEvidence, orchestration, quoteAggregate/);
    assert.match(page, /npm run backup -- export\|verify\|restore/);
    assert.match(page, /settings\.backup\.commands/);
    assert.match(page, /--confirm-empty-target/);
    assert.match(page, /--allow-partial --resume/);
    assert.match(page, /not available in Settings/);
    assert.doesNotMatch(page, /Try JSON|fall back to JSON|restore-drill"/i);
    assert.match(page, /display:\s*flex;\s*flex-direction:\s*column/);
    assert.match(page, /user-select:\s*text/);
    assert.match(page, /id="health-glance"/);
    assert.match(page, /class="fp-chip"/);
    assert.match(page, /must not contain service, approval, or delivery tokens/);
    assert.match(page, /Resume is a separate action/);
    assert.match(page, /min-height:\s*44px/);
    assert.match(page, /font-size:\s*12px/);
    assert.match(page, /font-size:\s*16px/);
    assert.match(page, /font-size:\s*14px;\s*font-weight:\s*600/);
    assert.match(page, /prefers-reduced-motion:\s*reduce/);
    assert.doesNotMatch(page, /sessionStorage|#39ff88|#b933ff|#ff2fbf|#39e6ff/i);
    const rails = [...dashboard.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(rails.filter((rail) => rail === "settings").length, 1);
    assert.deepEqual(
      [...dashboard.matchAll(/data-settings-tab="([^"]+)"/g)].map((match) => match[1]),
      ["general", "credentials", "persistence", "danger"],
    );
    assert.match(dashboard, /id="persistence-health-glance"/);
    assert.match(dashboard, /id="persistence-export-warning"/);
    assert.match(dashboard, /show_persistence_settings/);
    assert.doesNotMatch(dashboard, /id="open-persistence-settings"/);
  });

  it("uses danger actions and focuses Cancel when a dialog opens", () => {
    for (const id of [
      "dialog-export-classic",
      "dialog-verify-classic",
      "dialog-restore-classic",
      "dialog-export-v4",
      "dialog-verify-v4",
      "dialog-restore-v4",
      "dialog-resume-v4",
    ]) {
      const source = dialog(id);
      assert.match(source, /data-cancel autofocus/);
      assert.match(source, />Cancel</);
    }
    assert.match(dialog("dialog-restore-classic"), /class="danger"/);
    assert.match(dialog("dialog-restore-v4"), /class="danger"/);
    assert.match(dialog("dialog-resume-v4"), /class="danger"/);
    assert.doesNotMatch(dialog("dialog-export-classic"), /class="danger"/);
    assert.match(page, /function keepResumeExplicit\(\)/);
    assert.match(page, /if \(!result \|\| result\.status !== "completed"\) keepResumeExplicit\(\)/);
    assert.match(page, /id="restore-v4-resume" type="checkbox" \/>/);
    assert.doesNotMatch(page, /id="restore-v4-resume" type="checkbox" checked/);
    assert.match(page, /cancel\.focus\(\)/);
  });
});
