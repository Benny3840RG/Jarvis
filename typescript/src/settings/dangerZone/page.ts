import type { DangerZoneCard, DangerZoneModel } from "./catalog.js";
import { PERSISTENCE_BACKUP_HREF } from "./confirm.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function list(items: readonly string[]): string {
  if (items.length === 0) return "<p>None.</p>";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function statusLine(card: DangerZoneCard): string {
  if (card.disabledReason) return card.disabledReason;
  if (card.overlap === "on") return "Overlap on. Previous token still accepted.";
  if (card.overlap === "off") return "Overlap off. Previous token rejected.";
  if (card.overlap === "not-configured") return "Not configured.";
  return "Available.";
}

function convexLine(card: DangerZoneCard): string {
  if (
    card.id === "end-service-overlap" ||
    card.id === "end-approval-overlap" ||
    card.id === "end-delivery-overlap"
  ) {
    return "Convex owner data is untouched. This removes the previous deployment variable only.";
  }
  return "Convex owner data is untouched. This quarantines local JSON only.";
}

function cardSection(card: DangerZoneCard, backupPath: string | null): string {
  const disabled = card.enabled ? "" : " disabled";
  const backupGate =
    card.id === "clear-local"
      ? `<p class="note">Verified backup: ${escapeHtml(backupPath ?? "none in the last 24 hours")}</p>
      <label class="check"><input type="checkbox" name="skipBackup" /> I skip backup and accept irreversible local loss</label>
      <p><a class="link" href="${escapeHtml(PERSISTENCE_BACKUP_HREF)}">Open Persistence Backup</a></p>`
      : "";
  const resetGate =
    card.id === "reset-local-json"
      ? `<label class="check"><input type="checkbox" name="acceptEmptyLocalCore" /> I have a recent backup or accept empty local core</label>`
      : "";
  const fingerprint =
    card.fingerprint === null
      ? ""
      : `<p>Fingerprint <span class="fp-chip">${escapeHtml(card.fingerprint)}</span> (current)</p>`;
  return `<section class="card" id="${escapeHtml(card.id)}">
    <h2>${escapeHtml(card.title)}</h2>
    <p class="status">${escapeHtml(statusLine(card))}</p>
    <button type="button" class="danger" data-open="${escapeHtml(card.id)}"${disabled}>${escapeHtml(openLabel(card))}</button>
    <dialog data-action="${escapeHtml(card.id)}" data-confirm="${escapeHtml(card.confirm)}" data-backup-path="${escapeHtml(backupPath ?? "")}">
      <h3>${escapeHtml(card.title)}</h3>
      <p class="status">${escapeHtml(statusLine(card))}</p>
      ${card.warning ? `<p class="warning">${escapeHtml(card.warning)}</p>` : ""}
      <h3>What changes</h3>
      ${list(card.blastRadius)}
      ${fingerprint}
      <p>Will quarantine:</p>
      ${list(card.willQuarantine)}
      <p>Will not touch:</p>
      ${list(card.willNotTouch)}
      <p>${escapeHtml(convexLine(card))}</p>
      ${backupGate}
      ${resetGate}
      <details class="cli-help">
        <summary>CLI / runbook</summary>
        <p>${escapeHtml(card.cli)}</p>
        <p>Safer prelude, on Persistence Backup: <code>npm run backup -- export</code> then <code>npm run backup -- verify</code>.</p>
      </details>
      <label class="confirm-label">Type ${escapeHtml(card.confirm)}
        <input name="confirmation" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </label>
      <div class="actions">
        <button type="button" class="cancel" autofocus>Cancel</button>
        <button type="button" class="danger submit" disabled>${escapeHtml(submitLabel(card))}</button>
      </div>
      <p class="result" role="status"></p>
    </dialog>
  </section>`;
}

function openLabel(card: DangerZoneCard): string {
  switch (card.id) {
    case "end-service-overlap":
    case "end-approval-overlap":
    case "end-delivery-overlap":
      return "End overlap…";
    case "reset-local-json":
      return "Reset local JSON…";
    case "clear-local":
      return "Clear local data…";
    default:
      return card.title;
  }
}

function submitLabel(card: DangerZoneCard): string {
  switch (card.id) {
    case "end-service-overlap":
    case "end-approval-overlap":
    case "end-delivery-overlap":
      return "End overlap";
    case "reset-local-json":
      return "Reset local JSON";
    case "clear-local":
      return "Clear local data";
    default:
      return card.title;
  }
}

const PAGE_STYLE = `
    :root { color-scheme: dark; --bg:#1c1612; --panel:#2a211c; --line:#5c4a3d; --text:#f6efe6; --muted:#c4b5a5; --accent:#c47b4a; --gold:#d7a15f; --danger:#a33b32; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(920px, 100%); margin:0 auto; padding:20px 16px 48px; }
    h1 { font-size:22px; margin:0 0 6px; }
    h2, h3 { font-size:16px; margin:0; }
    p, li { margin:6px 0; font-size:16px; }
    .lede, .note, li { color:var(--muted); }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
    .tab, .link, button, input, summary, .check { min-height:44px; font-size:16px; }
    .tab { display:inline-flex; align-items:center; padding:0 14px; border-radius:9px; border:1px solid var(--line); color:var(--muted); text-decoration:none; }
    .tab[aria-current="page"] { color:var(--text); border-color:var(--accent); }
    .status { font-size:14px; font-weight:600; margin:8px 0; }
    .warning { border:1px solid rgba(215,161,95,.5); background:rgba(215,161,95,.12); color:var(--gold); border-radius:12px; padding:12px 14px; font-size:14px; font-weight:600; }
    .card { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:14px; margin:12px 0; }
    .fp-chip { display:inline-flex; align-items:center; min-height:44px; max-width:11rem; overflow:hidden; padding:0 12px; border-radius:999px; border:1px solid var(--line); background:#241c18; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:14px; font-weight:600; }
    button, .link { font:inherit; border-radius:9px; border:1px solid var(--line); background:#3a2e26; color:var(--text); padding:0 14px; text-decoration:none; display:inline-flex; align-items:center; }
    button.danger, a.danger { border-color:var(--danger); background:#4a2420; }
    button:disabled { opacity:.45; }
    .check { display:flex; align-items:center; gap:8px; }
    .confirm-label, #token-label { display:block; margin-top:12px; }
    input[name="confirmation"], #operator-token { display:block; width:100%; margin-top:6px; min-height:44px; font:16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#1c1612; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px; }
    dialog { border:1px solid var(--line); border-radius:16px; background:#241c18; color:var(--text); width:min(640px, calc(100% - 24px)); padding:16px; }
    dialog::backdrop { background:rgba(0,0,0,.62); }
    .actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; margin-top:16px; }
    summary { display:flex; align-items:center; cursor:pointer; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    @media (max-width:720px) {
      .actions button, .link, .tab { width:100%; }
    }
`;

export function renderDangerZonePage(model: DangerZoneModel): string {
  const backupPath = model.verifiedBackup?.path ?? null;
  const cards = model.cards.map((card) => cardSection(card, backupPath)).join("\n");
  const excluded = model.excluded.map((item) => `<li>${escapeHtml(item.reason)}</li>`).join("");
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'" />
  <title>Jarvis Settings · Danger zone</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <nav aria-label="Settings">
      <span class="tab">General</span>
      <a class="tab" href="/settings/credentials">Credentials</a>
      <a class="tab" href="${escapeHtml(PERSISTENCE_BACKUP_HREF)}">Persistence</a>
      <a class="tab" href="/settings/danger" aria-current="page">Danger zone</a>
    </nav>
    <h1>Danger zone</h1>
    <p class="lede">${escapeHtml(model.lede)}</p>
    <p class="status">Active provider: ${escapeHtml(model.provider)}. Credentials does not end overlap. This page is the only End path.</p>
    <p class="note">The service token stays in this field until you leave the page. It is not written to browser storage.</p>
    <label id="token-label">Service token for this action
      <input id="operator-token" type="password" autocomplete="off" spellcheck="false" />
    </label>
    ${cards}
    <section class="card">
      <h2>Not in this phase</h2>
      <ul>${excluded}</ul>
    </section>
  </main>
  <script>
    "use strict";
    const tokenField = document.querySelector("#operator-token");
    window.addEventListener("pagehide", () => { tokenField.value = ""; });
    for (const opener of document.querySelectorAll("[data-open]")) {
      opener.addEventListener("click", () => {
        const cardDialog = opener.parentElement.querySelector("dialog");
        cardDialog.showModal();
        cardDialog.querySelector(".cancel").focus();
      });
    }
    for (const dialog of document.querySelectorAll("dialog")) {
      const confirmValue = dialog.dataset.confirm;
      const input = dialog.querySelector("input[name=confirmation]");
      const submit = dialog.querySelector(".submit");
      const result = dialog.querySelector(".result");
      dialog.querySelector(".cancel").addEventListener("click", () => dialog.close());
      const ready = () => {
        if (input.value !== confirmValue) return false;
        if (dialog.dataset.action === "reset-local-json") {
          return dialog.querySelector("input[name=acceptEmptyLocalCore]").checked;
        }
        if (dialog.dataset.action === "clear-local") {
          const skip = dialog.querySelector("input[name=skipBackup]").checked;
          if (skip) return true;
          return dialog.dataset.backupPath.length > 0;
        }
        return true;
      };
      const refresh = () => { submit.disabled = !ready(); };
      input.addEventListener("input", refresh);
      dialog.addEventListener("change", refresh);
      submit.addEventListener("click", async () => {
        if (!ready()) return;
        const token = tokenField.value;
        if (!token) {
          result.textContent = "A service token is required. Nothing was changed.";
          return;
        }
        submit.disabled = true;
        result.textContent = "Working…";
        const body = { confirmation: input.value };
        if (dialog.dataset.action === "reset-local-json") body.acceptEmptyLocalCore = true;
        if (dialog.dataset.action === "clear-local") {
          const skip = dialog.querySelector("input[name=skipBackup]").checked;
          body.backup = skip
            ? { mode: "skip", acceptIrreversibleLoss: true }
            : { mode: "verified", path: dialog.dataset.backupPath };
        }
        try {
          const response = await fetch("/api/v1/settings/danger-zone/actions/" + dialog.dataset.action, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + token,
            },
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok) {
            result.textContent = payload.detail || "The action was refused.";
            refresh();
            return;
          }
          tokenField.value = "";
          result.textContent = (payload.detail || "Done.") + " Reload the page to see the new state.";
        } catch {
          result.textContent = "The action could not be sent. Nothing further was changed by this page.";
          refresh();
        }
      });
    }
  </script>
</body>
</html>`;
}
