import { CREDENTIAL_DOC_LINKS, type CredentialsPageModel } from "./credentialsStatus.js";

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function settingsNav(current: "credentials" | "danger"): string {
  const tab = (href: string, label: string, active: boolean): string =>
    active
      ? `<a class="tab" href="${href}" aria-current="page">${label}</a>`
      : `<a class="tab" href="${href}">${label}</a>`;
  const general =
    current === "credentials" ? "#settings-general" : "/settings/credentials#settings-general";
  const credentials = current === "credentials" ? "/settings/credentials" : "/settings/credentials";
  const persistence =
    current === "credentials"
      ? "#settings-persistence"
      : "/settings/credentials#settings-persistence";
  return `<nav aria-label="Settings">
      ${tab(general, "General", false)}
      ${tab(credentials, "Credentials", current === "credentials")}
      ${tab(persistence, "Persistence", false)}
      ${tab("/settings/danger", "Danger zone", current === "danger")}
    </nav>`;
}

const PAGE_STYLE = `
    :root { color-scheme: dark; --bg:#1c1612; --panel:#2a211c; --line:#5c4a3d; --text:#f6efe6; --muted:#c4b5a5; --accent:#c47b4a; --gold:#d7a15f; --danger:#a33b32; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(920px, 100%); margin:0 auto; padding:20px 16px 48px; }
    h1 { font-size:22px; margin:0 0 6px; }
    h2 { font-size:16px; margin:0; }
    p { margin:6px 0; font-size:16px; }
    .lede, .note, .parity li, .steps li { color:var(--muted); font-size:16px; }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
    .tab, .link, button, input { min-height:44px; font-size:16px; }
    .tab { display:inline-flex; align-items:center; padding:0 14px; border-radius:9px; border:1px solid var(--line); color:var(--muted); text-decoration:none; }
    .tab[aria-current="page"], nav strong { color:var(--text); border-color:var(--accent); }
    .status { font-size:14px; font-weight:600; margin:8px 0; }
    .banner, .warn { border:1px solid rgba(215,161,95,.5); background:rgba(215,161,95,.12); color:var(--gold); border-radius:12px; padding:12px 14px; margin:12px 0; font-size:14px; font-weight:600; }
    .banner { border-color:rgba(163,59,50,.55); background:rgba(163,59,50,.12); color:#f0c2bc; }
    .grid { display:grid; gap:12px; }
    .card { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:14px; }
    .card header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
    dl { display:grid; grid-template-columns:140px minmax(0,1fr); gap:6px 10px; margin:10px 0; }
    dt { color:var(--muted); font-size:16px; }
    dd { margin:0; font-size:16px; }
    .fp-chip { display:inline-flex; align-items:center; min-height:44px; padding:0 14px; border-radius:999px; border:1px solid var(--line); background:#241c18; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:20px; font-weight:600; letter-spacing:.02em; }
    .error { color:#f0c2bc; font-size:14px; font-weight:600; }
    .actions, .wizard-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    button, .link { font:inherit; border-radius:9px; border:1px solid var(--line); background:#3a2e26; color:var(--text); padding:0 14px; text-decoration:none; display:inline-flex; align-items:center; min-height:44px; }
    button.primary { border-color:var(--accent); background:#4a3428; }
    button:disabled { opacity:.45; }
    .secret { width:100%; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#1c1612; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px; }
    .dialog { border:1px solid var(--line); border-radius:16px; background:#241c18; color:var(--text); width:min(640px, calc(100% - 24px)); padding:0; }
    .dialog form, .dialog .body { padding:16px; }
    .steps { padding-left:18px; }
    pre { white-space:pre-wrap; background:#1c1612; border-radius:8px; padding:10px; color:var(--muted); font-size:16px; }
    .parity { padding-left:18px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    @media (max-width:720px) {
      dl { grid-template-columns:1fr; }
      .actions button, .wizard-actions button, .link, .tab { width:100%; }
    }
`;

/**
 * Loopback operator page. GET /settings/credentials is a public route so the
 * fail-closed banner can render without a Bearer token. The embedded model is
 * fingerprints and bind posture only. Full digests are not in the page. End
 * overlap is not offered here; the Danger zone link is the boundary.
 */
export function renderCredentialsPage(model: CredentialsPageModel): string {
  const data = embedJson(model);
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>Jarvis Settings · Credentials</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    ${settingsNav("credentials")}
    <h1 id="settings-credentials">Credentials</h1>
    <p class="status" id="verify-status">Not verified</p>
    <p class="note" id="verify-note">Idle has no End button. Guarding is shown only after this server attests a passing smoke result, and it still does not offer End.</p>
    <p class="lede">Machine credentials authenticate Jarvis clients and gated operations. They are not a sign-in. Secrets are never shown in full after first reveal. Report security issues without including token values.</p>
    <div id="banner" class="banner" hidden></div>
    <div id="approvals" class="warn" hidden></div>
    <div id="cards" class="grid"></div>
    <section class="card" id="http-card"></section>
    <section class="card" id="mcp-card"></section>
    <section class="card" id="exposure-card"></section>
    <section class="card" id="settings-general">
      <h2>General</h2>
      <p>Timezone and display preferences stay on the operator console Settings tab. This page does not store them and does not change CLI output.</p>
    </section>
    <section class="card" id="settings-persistence">
      <h2>Persistence</h2>
      <p class="status">Read only</p>
      <p>Export, verify, and restore are not this page. Nothing here changes JSON or Convex.</p>
    </section>
    <section class="card">
      <h2>CLI / runbook parity</h2>
      <ul class="parity" id="parity"></ul>
      <p class="note">Convex <code>env set</code> stays operator-driven. This page does not call it and does not remove the previous token. Overlap removal is not offered here. Open Danger zone for that boundary. HTTP checks use <code>curl --config -</code> so the Bearer value stays in the environment, not in a shell argument. Fingerprints are short chips. Full digests are not in this page.</p>
    </section>
  </main>
  <dialog class="dialog" id="wizard">
    <form method="dialog">
      <h2 id="wizard-title">Rotate</h2>
      <p id="wizard-step">Step 1 of 4</p>
      <div id="wizard-body"></div>
      <div class="wizard-actions">
        <button type="button" id="wizard-cancel">Cancel</button>
        <button type="button" id="wizard-back" hidden>Back</button>
        <button type="button" class="primary" id="wizard-next">Continue</button>
        <button type="button" class="primary" id="wizard-done" hidden>Done</button>
      </div>
    </form>
  </dialog>
  <script type="application/json" id="credentials-model">${data}</script>
  <script>
    "use strict";
    const model = JSON.parse(document.getElementById("credentials-model").textContent);
    const status = model.status;
    let revealed = "";
    function text(el, value) { el.textContent = value == null ? "" : String(value); }
    function wipe() { revealed = ""; const box = document.getElementById("secret-box"); if (box) box.value = ""; }
    window.addEventListener("pagehide", wipe);
    const banner = document.getElementById("banner");
    if (status.banner) { banner.hidden = false; text(banner, status.banner); }
    const approvals = document.getElementById("approvals");
    if (status.approvalsWarning) { approvals.hidden = false; text(approvals, status.approvalsWarning); }
    const cards = document.getElementById("cards");
    status.tokens.forEach((card) => {
      const section = document.createElement("section");
      section.className = "card";
      const header = document.createElement("header");
      const title = document.createElement("h2");
      text(title, card.label);
      header.append(title);
      section.append(header);
      const list = document.createElement("dl");
      const rows = [["Status", card.statusLabel], ["Overlap", card.overlapLabel]];
      if (card.owner) rows.splice(1, 0, ["Owner", card.owner]);
      rows.forEach(([label, value]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        text(dt, label);
        text(dd, value);
        if (label === "Status") dd.className = "status";
        list.append(dt, dd);
      });
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      text(dt, "Fingerprint");
      const chip = document.createElement("span");
      chip.className = "fp-chip";
      text(chip, card.fingerprint || "—");
      dd.append(chip);
      list.append(dt, dd);
      section.append(list);
      const note = document.createElement("p");
      note.className = "note";
      text(note, card.note);
      section.append(note);
      if (card.warning) {
        const warn = document.createElement("p");
        warn.className = card.equalsServiceToken ? "error" : "warn";
        text(warn, card.warning);
        section.append(warn);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      if (card.fingerprint) {
        const copy = document.createElement("button");
        copy.type = "button";
        text(copy, "Copy fingerprint");
        copy.addEventListener("click", () => navigator.clipboard.writeText(card.fingerprint));
        actions.append(copy);
      }
      const rotate = document.createElement("button");
      rotate.type = "button";
      rotate.className = "primary";
      text(rotate, card.id === "delivery" && !card.configured ? "Configure…" : "Rotate…");
      rotate.addEventListener("click", () => openWizard(card.id));
      actions.append(rotate);
      actions.append(link("/settings/danger#" + card.id, "Open Danger zone"));
      section.append(actions);
      cards.append(section);
    });
    function link(href, label) {
      const anchor = document.createElement("a");
      anchor.className = "link";
      anchor.href = href;
      anchor.rel = "noreferrer";
      text(anchor, label);
      return anchor;
    }
    const http = document.getElementById("http-card");
    const httpTitle = document.createElement("h2");
    text(httpTitle, "HTTP service");
    const httpList = document.createElement("dl");
    [["Bind", status.bind.httpHost + ":" + status.bind.httpPort], ["Auth", status.bind.httpAuth], ["Remote", status.bind.remoteLabel], ["Liveness", status.bind.liveness]].forEach(([label, value]) => {
      const dt = document.createElement("dt"); const dd = document.createElement("dd"); text(dt, label); text(dd, value); httpList.append(dt, dd);
    });
    http.append(httpTitle, httpList, link(status.docs.httpApi, "Open HTTP API docs"));
    const mcp = document.getElementById("mcp-card");
    const mcpTitle = document.createElement("h2");
    text(mcpTitle, "MCP preview");
    const mcpList = document.createElement("dl");
    [["Bind", status.bind.mcpBind], ["Token", status.bind.mcpToken], ["Models/UI", "Never receive the service token"], ["Remote", "Blocked"]].forEach(([label, value]) => {
      const dt = document.createElement("dt"); const dd = document.createElement("dd"); text(dt, label); text(dd, value); mcpList.append(dt, dd);
    });
    mcp.append(mcpTitle, mcpList, link(status.docs.mcpPreview, "Open MCP preview runbook"));
    const exposure = document.getElementById("exposure-card");
    const exposureTitle = document.createElement("h2");
    text(exposureTitle, "Exposure");
    const exposureList = document.createElement("dl");
    [["Mode", status.exposure.mode], ["Remote HTTP", status.exposure.remoteHttpLabel]].forEach(([label, value]) => {
      const dt = document.createElement("dt"); const dd = document.createElement("dd"); text(dt, label); text(dd, value); exposureList.append(dt, dd);
    });
    const exposureNote = document.createElement("p");
    exposureNote.className = "note";
    text(exposureNote, "There is no control here to expose Jarvis to a LAN or the public internet. Remote HTTP stays fail-closed until TLS, OIDC, allowed origins, and limits are configured together.");
    exposure.append(exposureTitle, exposureList, exposureNote, link(status.docs.exposure, "Open exposure / remote gateway docs"));
    const parity = document.getElementById("parity");
    status.parity.forEach((row) => {
      const item = document.createElement("li");
      text(item, row.ui + " — " + row.command);
      parity.append(item);
    });
    const flows = {
      service: {
        title: "Rotate service token",
        env: "JARVIS_SERVICE_TOKEN",
        previous: "JARVIS_SERVICE_TOKEN_PREVIOUS",
        duty: "Keep the old token accepted while clients switch.",
        verify: "smoke",
      },
      approval: {
        title: "Rotate approval token",
        env: "JARVIS_APPROVAL_TOKEN",
        previous: "JARVIS_APPROVAL_TOKEN_PREVIOUS",
        duty: "Possessing the service token must not be enough to approve tool-actions.",
        verify: "docs",
      },
      delivery: {
        title: "Configure delivery runtime token",
        env: "JARVIS_DELIVERY_RUNTIME_TOKEN",
        previous: "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
        duty: "Optional until delivery is enabled. The value must differ from the service token. This page does not keep a service digest, so compare after restart using the delivery card.",
        verify: "docs",
      },
    };
    const wizard = document.getElementById("wizard");
    let flowId = "service";
    let step = 1;
    function generateToken() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    function renderWizard() {
      const flow = flows[flowId];
      text(document.getElementById("wizard-title"), flow.title);
      text(document.getElementById("wizard-step"), "Step " + step + " of 4");
      const body = document.getElementById("wizard-body");
      body.replaceChildren();
      document.getElementById("wizard-back").hidden = step === 1;
      document.getElementById("wizard-next").hidden = step === 4;
      document.getElementById("wizard-done").hidden = step !== 4;
      if (step === 1) {
        const copy = document.createElement("p");
        text(copy, "Generate a new token. It is shown once. Store it in .env.local as " + flow.env + ".");
        body.append(copy);
        if (!revealed) {
          const button = document.createElement("button");
          button.type = "button";
          text(button, "Generate new token");
          button.addEventListener("click", () => { revealed = generateToken(); renderWizard(); });
          body.append(button);
        } else {
          const input = document.createElement("input");
          input.id = "secret-box";
          input.className = "secret";
          input.readOnly = true;
          input.value = revealed;
          input.setAttribute("autocomplete", "off");
          const hint = document.createElement("p");
          hint.className = "note";
          text(hint, "It will not be shown again. Copy it to a private password manager or env file.");
          const copyButton = document.createElement("button");
          copyButton.type = "button";
          text(copyButton, "Copy");
          copyButton.addEventListener("click", () => navigator.clipboard.writeText(revealed));
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.id = "copied";
          label.append(checkbox, document.createTextNode(" I copied the token to a private password manager / env file"));
          body.append(input, hint, copyButton, label);
        }
      } else if (step === 2) {
        const copy = document.createElement("p");
        text(copy, flow.duty);
        const pre = document.createElement("pre");
        text(pre, "npx convex dev --once --tail-logs disable\\nprintf '%s\\\\n' \\"$OLD_TOKEN\\" | npx convex env set " + flow.previous + "\\nprintf '%s\\\\n' \\"$NEW_TOKEN\\" | npx convex env set " + flow.env);
        body.append(copy, pre, link(status.docs.rotation, "Open rotation runbook"));
      } else if (step === 3) {
        const copy = document.createElement("p");
        text(copy, "Update .env.local " + flow.env + ". chmod 600 .env.local. Restart CLI / HTTP / MCP processes that cached the old env.");
        body.append(copy);
      } else {
        const copy = document.createElement("p");
        text(copy, flow.verify === "smoke"
          ? "Run npm run smoke:convex only against deployments starting with dev:. This page does not observe that command and does not offer End."
          : "No smoke:convex equivalent is required. Confirm the secret is stored apart from the service token. This page does not offer End.");
        const state = document.createElement("p");
        state.className = "status";
        text(state, "Not verified. Removal is CLI-only on the Danger zone card for this token.");
        body.append(copy, state, link("/settings/danger#" + flowId, "Open Danger zone"), link(status.docs.credentials, "Open credentials runbook"));
      }
    }
    function openWizard(id) {
      wipe();
      flowId = id;
      step = 1;
      renderWizard();
      wizard.showModal();
    }
    document.getElementById("wizard-cancel").addEventListener("click", () => { wipe(); wizard.close(); });
    document.getElementById("wizard-back").addEventListener("click", () => { if (step > 1) { step -= 1; renderWizard(); } });
    document.getElementById("wizard-next").addEventListener("click", () => {
      if (step === 1) {
        if (!revealed) return;
        const copied = document.getElementById("copied");
        if (!copied || !copied.checked) return;
        wipe();
      }
      if (step < 4) { step += 1; renderWizard(); }
    });
    document.getElementById("wizard-done").addEventListener("click", () => { wipe(); wizard.close(); });
  </script>
</body>
</html>`;
}

export const CREDENTIALS_PAGE_DOC_LINKS = CREDENTIAL_DOC_LINKS;
