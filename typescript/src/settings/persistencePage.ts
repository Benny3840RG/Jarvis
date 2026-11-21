import type { PersistenceProviderName } from "../persistence/providerSelection.js";
import { PERSISTENCE_BACKUP_HREF } from "./dangerZone/confirm.js";
import { SETTINGS_PAGE_STYLE } from "./limits/page.js";
import { LIMITS_PAGE_HREF } from "./limits/readModel.js";
import {
  ARCHIVE_SECRET_WARNING,
  ARCHIVE_V4_DOCS_PATH,
  CLASSIC_GAPS,
  CLASSIC_INCLUDED,
  NO_SILENT_FALLBACK,
  PERSISTENCE_COMMANDS,
  PROVIDER_HELPER,
  V4_CONVEX_EXPORT_COPY,
} from "./persistenceSettings.js";

export const PERSISTENCE_PAGE_HREF = "/settings/persistence" as const;

const PERSISTENCE_DOCS_PATH = "typescript/docs/operators/persistence-settings.md";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function commandRows(prefix: "classic" | "v4"): string {
  const label = prefix === "classic" ? / classic$/ : / v4$/;
  return PERSISTENCE_COMMANDS.filter((entry) => entry.exposedInSettings && label.test(entry.action))
    .map(
      (entry) =>
        `<dt>${escapeHtml(entry.action)}</dt><dd><code>${escapeHtml(entry.command)}</code></dd>`,
    )
    .join("\n      ");
}

/**
 * Loopback Persistence page. It is the target of the Danger zone "Persistence
 * Backup" link. It is a read-only projection of the backup CLI: it shows the
 * active provider and the exact commands, and it runs nothing. The page has no
 * script, holds no Bearer token, and never offers a provider switch or a JSON
 * fallback. Running an action from a button stays on the operator console's
 * Persistence tab, which calls the authenticated API.
 */
export function renderPersistencePage(provider: PersistenceProviderName): string {
  const convexNote =
    provider === "convex"
      ? `<p class="banner" role="status">${escapeHtml(V4_CONVEX_EXPORT_COPY)}</p>`
      : "";
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>NOLAN Settings · Persistence</title>
  <style>${SETTINGS_PAGE_STYLE}
    code { font:14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; }
  </style>
</head>
<body>
  <main>
    <nav aria-label="Settings">
      <span class="tab">General</span>
      <a class="tab" href="/settings/credentials">Credentials</a>
      <a class="tab" href="${escapeHtml(PERSISTENCE_BACKUP_HREF)}" aria-current="page">Persistence</a>
      <a class="tab" href="${escapeHtml(LIMITS_PAGE_HREF)}">Limits</a>
      <a class="tab" href="/settings/danger">Danger zone</a>
    </nav>
    <h1>Persistence</h1>
    <p class="lede">Read only. This page runs nothing and does not switch providers. Run the commands below from <code>typescript/</code> in a terminal, or use the Persistence tab in the operator console.</p>
    <section class="card" id="provider">
      <h2>Active provider</h2>
      <p class="status"><span class="chip" data-chip="provider">${escapeHtml(provider)}</span></p>
      <p class="note">${escapeHtml(NO_SILENT_FALLBACK)}</p>
      <p class="note">${escapeHtml(PROVIDER_HELPER)}</p>
    </section>
    <section class="card" id="backup">
      <h2>Backup</h2>
      <p class="banner" role="note">${escapeHtml(ARCHIVE_SECRET_WARNING)}</p>
      ${convexNote}
      <h3>Classic archive</h3>
      <p class="note">Includes ${escapeHtml(CLASSIC_INCLUDED)}.</p>
      <p class="note">${escapeHtml(CLASSIC_GAPS)}</p>
      <dl>
      ${commandRows("classic")}
      </dl>
      <h3>Archive v4 (Partial / JSON-only)</h3>
      <p class="note">Archive v4 is partial and is not a complete backup. Restore needs <code>--allow-partial</code>. Resume is a separate command and is never the default after a failure.</p>
      <dl>
      ${commandRows("v4")}
      </dl>
      <p class="note">Classic restore is empty-target only. It never merges.</p>
    </section>
    <section class="card">
      <h2>More</h2>
      <ul>
        <li><code>${escapeHtml(PERSISTENCE_DOCS_PATH)}</code></li>
        <li><code>${escapeHtml(ARCHIVE_V4_DOCS_PATH)}</code></li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}
