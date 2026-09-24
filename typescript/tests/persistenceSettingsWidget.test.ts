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
    assert.match(page, /id="provider-active"/);
    assert.doesNotMatch(page, /type="radio"/);
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
    const persistenceStart = dashboard.indexOf('id="view-persistence"');
    const persistenceEnd = dashboard.indexOf('id="view-danger"');
    assert.ok(persistenceStart !== -1 && persistenceEnd > persistenceStart);
    const persistence = dashboard.slice(persistenceStart, persistenceEnd);
    const backupExport =
      persistence.match(/id="persistence-backup-export"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.match(backupExport, /Backup \/ Export/);
    assert.match(
      backupExport,
      /class="settings-save"[^>]*id="persistence-backup"[^>]*>\s*Backup\s*</,
    );
    assert.match(backupExport, /id="persistence-export"[^>]*>\s*Export\s*</);
    assert.doesNotMatch(
      backupExport.match(/<button[^>]*id="persistence-export"[^>]*>/)?.[0] ?? "",
      /settings-save/,
    );
    assert.doesNotMatch(backupExport, /[Rr]estore/);
    assert.equal([...persistence.matchAll(/class="settings-save"/g)].length, 1);
    assert.doesNotMatch(
      persistence.match(/<button[^>]*id="persistence-restore-classic"[^>]*>/)?.[0] ?? "",
      /settings-save/,
    );
    assert.doesNotMatch(
      persistence.match(/<button[^>]*id="persistence-restore-v4"[^>]*>/)?.[0] ?? "",
      /settings-save/,
    );
    const dashboardV4 =
      persistence.match(/<details id="persistence-v4-format">[\s\S]*?<\/details>/)?.[0] ?? "";
    assert.match(dashboardV4, /id="persistence-restore-v4"/);
    assert.doesNotMatch(dashboardV4, /persistence-resume-v4|Resume interrupted/);
    assert.match(persistence, /<details id="persistence-resume">/);
    assert.match(persistence, /id="persistence-resume-v4"/);
    assert.match(persistence, /<details id="persistence-classic-format">/);
    assert.match(persistence, /<details id="persistence-v4-format">/);
    assert.doesNotMatch(persistence, /<details[^>]*\sopen/);
    assert.doesNotMatch(persistence, /type="radio"/);
    assert.match(persistence, /id="persistence-provider-label"/);
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
    assert.doesNotMatch(
      dialog("dialog-restore-v4"),
      /restore-v4-resume|type="checkbox"[^>]*resume/,
    );
    assert.doesNotMatch(page, /keepResumeExplicit|restore-v4-resume/);
    assert.match(page, /resume:\s*false/);
    assert.match(page, /cancel\.focus\(\)/);
    const backupExport = page.match(/id="backup-export-cluster"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.match(backupExport, /Backup \/ Export/);
    assert.match(backupExport, /class="primary"[^>]*id="open-export-classic"[^>]*>\s*Backup\s*</);
    assert.match(backupExport, /id="open-export"[^>]*>\s*Export\s*</);
    assert.doesNotMatch(
      backupExport.match(/<button[^>]*id="open-export"[^>]*>/)?.[0] ?? "",
      /primary/,
    );
    assert.doesNotMatch(backupExport, /[Rr]estore|resume/);
    const widgetV4 = page.match(/<details id="v4-format">[\s\S]*?<\/details>/)?.[0] ?? "";
    assert.match(widgetV4, /id="open-restore-v4"/);
    assert.doesNotMatch(widgetV4, /open-resume-v4|restore-v4-resume|Resume interrupted/);
    assert.match(page, /<details id="resume-format">/);
    assert.match(page, /id="open-resume-v4"/);
    assert.match(page, /class="primary"/);
    assert.match(page, /<details id="classic-format">/);
    assert.match(page, /<details id="v4-format">/);
    assert.doesNotMatch(page, /<details[^>]*\sopen/);
  });
});
