import { CREDENTIAL_DOC_LINKS, type CredentialsPageModel } from "./credentialsStatus.js";

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Loopback operator page. GET /settings/credentials is a public route so the
 * fail-closed banner can render without a Bearer token. The embedded model
 * contains short fingerprints plus full SHA-256 digests of the current and
 * previous service tokens. Those digests are not raw tokens. They stay in the
 * page so a delivery token can be rejected locally: the content-security policy
 * forbids network calls, so the revealed value cannot be posted to MCP or the
 * API. The authenticated JSON status response does not include the digests.
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
  <style>
    :root { color-scheme: dark; --bg:#05060a; --panel:#111522; --line:#282d3d; --text:#f4f5fb; --muted:#949bb0; --green:#39ff88; --yellow:#f0c75e; --red:#ff5c75; --violet:#b933ff; }
    * { box-sizing: border-box; }
    body { margin:0; font:15px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(920px, 100%); margin:0 auto; padding:20px 16px 48px; }
    h1 { font-size:22px; margin:0 0 6px; }
    h2 { font-size:15px; margin:0; }
    p { margin:6px 0; }
    .lede, .note, .parity li, .steps li { color:var(--muted); }
    nav { display:flex; gap:10px; align-items:center; margin-bottom:16px; color:var(--muted); font-size:13px; }
    nav strong { color:var(--text); }
    .banner, .warn { border:1px solid rgba(240,199,94,.5); background:rgba(240,199,94,.1); color:var(--yellow); border-radius:12px; padding:12px 14px; margin:12px 0; }
    .banner { border-color:rgba(255,92,117,.55); background:rgba(255,92,117,.1); color:var(--red); }
    .grid { display:grid; gap:12px; }
    .card { border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:14px; }
    .card header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
    dl { display:grid; grid-template-columns:140px minmax(0,1fr); gap:6px 10px; margin:10px 0; }
    dt { color:var(--muted); }
    dd { margin:0; }
    .fp { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing:.02em; }
    .error { color:var(--red); }
    .actions, .wizard-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    button, .link { font:inherit; border-radius:9px; border:1px solid var(--line); background:#171b29; color:var(--text); padding:8px 12px; text-decoration:none; display:inline-flex; }
    button.primary { border-color:rgba(57,255,136,.45); background:rgba(57,255,136,.12); }
    button.secondary { border-color:rgba(185,51,255,.45); }
    button:disabled { opacity:.45; }
    .secret { width:100%; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#05060a; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px; }
    .dialog { border:1px solid var(--line); border-radius:16px; background:#0b0e15; color:var(--text); width:min(640px, calc(100% - 24px)); padding:0; }
    .dialog form, .dialog .body { padding:16px; }
    .steps { padding-left:18px; }
    pre { white-space:pre-wrap; background:#05060a; border-radius:8px; padding:10px; color:var(--muted); }
    .parity { padding-left:18px; }
    @media (max-width:720px) {
      dl { grid-template-columns:1fr; }
      .actions button, .wizard-actions button, .link { width:100%; }
    }
  </style>
</head>
<body>
  <main>
    <nav aria-label="Settings"><span>Settings</span><span>/</span><strong>Credentials</strong></nav>
    <h1>Credentials</h1>
    <p class="lede">Machine credentials authenticate Jarvis clients and gated operations. They are not a sign-in. Secrets are never shown in full after first reveal. Report security issues without including token values.</p>
    <div id="banner" class="banner" hidden></div>
    <div id="approvals" class="warn" hidden></div>
    <div id="cards" class="grid"></div>
    <section class="card" id="http-card"></section>
    <section class="card" id="mcp-card"></section>
    <section class="card" id="exposure-card"></section>
    <section class="card">
      <h2>CLI / runbook parity</h2>
      <ul class="parity" id="parity"></ul>
      <p class="note">Convex <code>env set</code> stays operator-driven. This page does not call it and does not remove the previous token. End overlap only shows the CLI command. Danger zone is not this page. HTTP checks use <code>curl --config -</code> so the Bearer value stays in the environment, not in a shell argument. The embedded service digests are SHA-256 values for a local collision check, not the token.</p>
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
        <button type="button" class="secondary" id="wizard-end" hidden>End overlap…</button>
        <button type="button" class="primary" id="wizard-done" hidden>Done</button>
      </div>
    </form>
  </dialog>
  <dialog class="dialog" id="end-dialog">
    <form id="end-form">
      <h2>End token overlap</h2>
      <p id="end-copy"></p>
      <label>Type <span class="fp">END OVERLAP</span>
        <input class="secret" id="end-phrase" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </label>
      <div class="wizard-actions">
        <button type="button" id="end-cancel">Cancel</button>
        <button type="submit" class="secondary" id="end-confirm" disabled>End overlap</button>
      </div>
      <pre id="end-commands" hidden></pre>
    </form>
  </dialog>
  <script type="application/json" id="credentials-model">${data}</script>
  <script>
    "use strict";
    const model = JSON.parse(document.getElementById("credentials-model").textContent);
    const status = model.status;
    const serviceDigests = Array.isArray(model.serviceDigests) ? model.serviceDigests : [];
    let revealed = "";
    function endOverlapControl(confirmation, verify, context) {
      void verify;
      void context;
      const allowed = confirmation === "END OVERLAP";
      return { offered: true, primary: false, allowed: allowed, executesRemoval: false };
    }
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
      const rows = [["Status", card.statusLabel], ["Fingerprint", card.fingerprint || "—"], ["Overlap", card.overlapLabel]];
      if (card.owner) rows.splice(2, 0, ["Owner", card.owner]);
      rows.forEach(([label, value]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        text(dt, label);
        text(dd, value);
        if (label === "Fingerprint") dd.className = "fp";
        list.append(dt, dd);
      });
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
      const end = document.createElement("button");
      end.type = "button";
      end.dataset.end = card.id;
      text(end, "End overlap…");
      end.addEventListener("click", () => openEnd(card.id, "card", "idle"));
      actions.append(end);
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
        duty: "Optional until delivery is enabled. The value must differ from the service token.",
        verify: "docs",
      },
    };
    const wizard = document.getElementById("wizard");
    let flowId = "service";
    let step = 1;
    let verify = "idle";
    async function sha256Hex(value) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    function generateToken() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    async function renderWizard() {
      const flow = flows[flowId];
      text(document.getElementById("wizard-title"), flow.title);
      text(document.getElementById("wizard-step"), "Step " + step + " of 4");
      const body = document.getElementById("wizard-body");
      body.replaceChildren();
      document.getElementById("wizard-back").hidden = step === 1;
      document.getElementById("wizard-next").hidden = step === 4;
      document.getElementById("wizard-done").hidden = step !== 4;
      const end = document.getElementById("wizard-end");
      const control = endOverlapControl("", verify, "wizard");
      end.hidden = !control.offered;
      end.classList.toggle("primary", control.primary);
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
          const copy = document.createElement("button");
          copy.type = "button";
          text(copy, "Copy");
          copy.addEventListener("click", () => navigator.clipboard.writeText(revealed));
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.id = "copied";
          label.append(checkbox, document.createTextNode(" I copied the token to a private password manager / env file"));
          body.append(input, hint, copy, label);
          if (flowId !== "service") {
            const digest = await sha256Hex(revealed);
            if (serviceDigests.includes(digest)) {
              const error = document.createElement("p");
              error.className = "error";
              text(error, "Must differ from the service token.");
              body.append(error);
            }
          }
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
          ? "Run npm run smoke:convex only against deployments starting with dev:. The command reads the token from the environment."
          : "No smoke:convex equivalent is required. Confirm the secret is stored apart from the service token.");
        const pass = document.createElement("button");
        pass.type = "button";
        text(pass, flow.verify === "smoke" ? "Smoke passed" : "Verification noted");
        pass.addEventListener("click", () => { verify = "passing"; renderWizard(); });
        const fail = document.createElement("button");
        fail.type = "button";
        text(fail, flow.verify === "smoke" ? "Smoke failed" : "Verification failed");
        fail.addEventListener("click", () => { verify = "failing"; renderWizard(); });
        const state = document.createElement("p");
        text(state, verify === "failing"
          ? "You marked verification failed. That mark does not hide the CLI command. This page does not run smoke and does not remove the previous token."
          : verify === "passing"
            ? "You marked verification passed. This page did not run smoke. End overlap only shows the CLI command."
            : "Smoke is not observed here. End overlap only shows the CLI command. Danger zone is not this page.");
        body.append(copy, pass, fail, state, link(status.docs.credentials, "Open credentials runbook"));
      }
    }
    function openWizard(id) {
      wipe();
      flowId = id;
      step = 1;
      verify = "idle";
      renderWizard();
      wizard.showModal();
    }
    document.getElementById("wizard-cancel").addEventListener("click", () => { wipe(); wizard.close(); });
    document.getElementById("wizard-back").addEventListener("click", () => { if (step > 1) { step -= 1; renderWizard(); } });
    document.getElementById("wizard-next").addEventListener("click", async () => {
      if (step === 1) {
        if (!revealed) return;
        const copied = document.getElementById("copied");
        if (!copied || !copied.checked) return;
        if (flowId !== "service") {
          const digest = await sha256Hex(revealed);
          if (serviceDigests.includes(digest)) return;
        }
        wipe();
      }
      if (step < 4) { step += 1; renderWizard(); }
    });
    document.getElementById("wizard-done").addEventListener("click", () => { wipe(); wizard.close(); });
    document.getElementById("wizard-end").addEventListener("click", () => openEnd(flowId, "wizard", verify));
    const endDialog = document.getElementById("end-dialog");
    let endId = "service";
    let endVerify = "idle";
    let endContext = "card";
    function openEnd(id, context, verifyState) {
      const control = endOverlapControl("", verifyState, context);
      if (!control.offered) return;
      endId = id;
      endVerify = verifyState;
      endContext = context;
      document.getElementById("end-phrase").value = "";
      document.getElementById("end-confirm").disabled = true;
      document.getElementById("end-commands").hidden = true;
      text(document.getElementById("end-copy"), "Shows the CLI command for the previous " + flows[id].env + " credential. This page does not remove it. Clients still on the old token fail closed only after you run that command yourself. Danger zone is not this page.");
      endDialog.showModal();
    }
    document.getElementById("end-phrase").addEventListener("input", (event) => {
      const control = endOverlapControl(event.target.value, endVerify, endContext);
      document.getElementById("end-confirm").disabled = !control.allowed;
      document.getElementById("end-confirm").classList.toggle("primary", control.primary);
    });
    document.getElementById("end-cancel").addEventListener("click", () => endDialog.close());
    document.getElementById("end-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const control = endOverlapControl(document.getElementById("end-phrase").value, endVerify, endContext);
      if (!control.allowed || control.primary) return;
      const commands = {
        service: "npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS",
        approval: "npx convex env remove JARVIS_APPROVAL_TOKEN_PREVIOUS",
        delivery: "npx convex env remove JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
      };
      const pre = document.getElementById("end-commands");
      pre.hidden = false;
      text(pre, commands[endId] + "\\nRemove the matching PREVIOUS variable from .env.local if it is set, then chmod 600 .env.local");
      document.getElementById("end-phrase").value = "";
    });
  </script>
</body>
</html>`;
}

export const CREDENTIALS_PAGE_DOC_LINKS = CREDENTIAL_DOC_LINKS;
