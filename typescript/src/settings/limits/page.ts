import { PERSISTENCE_BACKUP_HREF } from "../dangerZone/confirm.js";
import {
  CHANGE_LIMIT_PHRASE,
  LIMITS_PAGE_HREF,
  type ProviderQuotaReadModel,
  type ProviderQuotaResource,
} from "./readModel.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resourceCard(resource: ProviderQuotaResource): string {
  return `<article class="card" id="${escapeHtml(resource.id)}" data-resource="${escapeHtml(resource.id)}">
    <h2>${escapeHtml(resource.title)}</h2>
    <p class="status"><span class="kind">Soft</span> <span class="chip" data-chip="${escapeHtml(resource.chip)}">${escapeHtml(resource.chip)}</span></p>
    <p class="status"><span class="kind">Hard</span> <span class="hard-stop">${escapeHtml(resource.hardStop)}</span></p>
    <dl>
      <dt>Used</dt><dd>Unknown</dd>
      <dt>Limit</dt><dd>Unknown</dd>
      <dt>Remaining</dt><dd>Unknown</dd>
      <dt>Reset period</dt><dd>${escapeHtml(resource.resetPeriod)}</dd>
    </dl>
    <h3>If a hard stop is hit</h3>
    <p>${escapeHtml(resource.hitHard)}</p>
    <h3>If this limit changes</h3>
    <p>${escapeHtml(resource.changeLimit)}</p>
    <button type="button" data-open="change-limit">Change limit…</button>
  </article>`;
}

const PAGE_STYLE = `
    :root { color-scheme: dark; --bg:#1c1612; --panel:#2a211c; --line:#5c4a3d; --text:#f6efe6; --muted:#c4b5a5; --accent:#c47b4a; --gold:#d7a15f; --danger:#a33b32; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(920px, 100%); margin:0 auto; padding:20px 16px 48px; }
    h1 { font-size:22px; margin:0 0 6px; }
    h2, h3 { font-size:16px; margin:0; }
    p, li, dt, dd { margin:6px 0; font-size:16px; }
    .lede, .note, li, dt { color:var(--muted); }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
    .tab, button, input, summary { min-height:44px; font-size:16px; }
    .tab { display:inline-flex; align-items:center; padding:0 14px; border-radius:9px; border:1px solid var(--line); color:var(--muted); text-decoration:none; }
    .tab[aria-current="page"] { color:var(--text); border-color:var(--accent); }
    .status { font-size:14px; font-weight:600; margin:8px 0; }
    .banner { border:1px solid rgba(215,161,95,.5); background:rgba(215,161,95,.12); color:var(--gold); border-radius:12px; padding:12px 14px; font-size:14px; font-weight:600; }
    .card { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:14px; margin:12px 0; }
    .chip { display:inline-flex; align-items:center; min-height:44px; padding:0 14px; border-radius:999px; border:1px solid var(--line); background:#241c18; color:var(--muted); font-size:14px; font-weight:600; }
    dl { display:grid; grid-template-columns:140px minmax(0,1fr); gap:6px 10px; margin:10px 0; }
    dd { margin:0; }
    button { font:inherit; border-radius:9px; border:1px solid var(--line); background:#3a2e26; color:var(--text); padding:0 14px; }
    button:disabled { opacity:.45; }
    dialog { border:1px solid var(--line); border-radius:16px; background:#241c18; color:var(--text); width:min(640px, calc(100% - 24px)); padding:16px; }
    dialog::backdrop { background:rgba(28,22,18,.72); }
    label { display:block; margin-top:12px; }
    input { display:block; width:100%; margin-top:6px; font:16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#1c1612; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px; }
    .actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; margin-top:16px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    @media (max-width:720px) {
      .actions button, .tab { width:100%; }
      dl { grid-template-columns:1fr; }
    }
`;

/**
 * Loopback operator page. There is no quota writer. The confirm dialog explains
 * blast radius and then refuses to save.
 */
export function renderLimitsPage(model: ProviderQuotaReadModel): string {
  const cards = model.resources.map((resource) => resourceCard(resource)).join("\n");
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>Jarvis Settings · Limits</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <nav aria-label="Settings">
      <span class="tab">General</span>
      <a class="tab" href="/settings/credentials">Credentials</a>
      <a class="tab" href="${escapeHtml(PERSISTENCE_BACKUP_HREF)}">Persistence</a>
      <a class="tab" href="${escapeHtml(LIMITS_PAGE_HREF)}" aria-current="page">Limits</a>
      <a class="tab" href="/settings/danger">Danger zone</a>
    </nav>
    <h1>Limits</h1>
    <p class="banner" role="status">${escapeHtml(model.banner)}</p>
    <p class="lede">Operator only. There is no team-admin path. The console shows one NOW chip, ${escapeHtml(model.nowChip.label)}. That chip is not editable.</p>
    <p class="status">Chip states: OK, WARN, STOPPED, UNKNOWN, NO LIMIT. The store is unread, so every resource is UNKNOWN. Remaining is not invented.</p>
    <p class="status">Reset period ${escapeHtml(model.resetPeriod)}.</p>
    ${cards}
    <section class="card">
      <h2>Not on this page</h2>
      <ul>
        <li>Seats, billing, and paywall are not provider quotas.</li>
        <li>Notifications and Sessions are not settings tabs.</li>
        <li>There is no team-admin path.</li>
      </ul>
    </section>
    <dialog id="change-limit" data-confirm="${escapeHtml(CHANGE_LIMIT_PHRASE)}">
      <h2>Change limit</h2>
      <p>Changing a limit does not save. The durable quota store is pending. Nothing is enforced.</p>
      <h3>If a hard stop is hit</h3>
      <ul>
        <li>New provider calls, overlapping work, backup writes, retention expiry, or delivery sends for that resource would be refused.</li>
        <li>Work already in flight is not rolled back by this page.</li>
      </ul>
      <label>Type ${escapeHtml(CHANGE_LIMIT_PHRASE)}
        <input name="confirmation" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </label>
      <div class="actions">
        <button type="button" class="cancel" autofocus>Cancel</button>
        <button type="button" class="submit" disabled>Change limit</button>
      </div>
      <p class="result" role="status"></p>
    </dialog>
  </main>
  <script>
    "use strict";
    const dialog = document.querySelector("#change-limit");
    const input = dialog.querySelector("input[name=confirmation]");
    const submit = dialog.querySelector(".submit");
    const result = dialog.querySelector(".result");
    const phrase = dialog.dataset.confirm;
    for (const opener of document.querySelectorAll("[data-open]")) {
      opener.addEventListener("click", () => {
        result.textContent = "";
        input.value = "";
        submit.disabled = true;
        dialog.showModal();
        dialog.querySelector(".cancel").focus();
      });
    }
    dialog.querySelector(".cancel").addEventListener("click", () => dialog.close());
    input.addEventListener("input", () => { submit.disabled = input.value !== phrase; });
    submit.addEventListener("click", () => {
      if (input.value !== phrase) return;
      result.textContent = "Not saved. Durable quota store is pending. Nothing was enforced.";
    });
  </script>
</body>
</html>`;
}
