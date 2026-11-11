// Owner decision queue page (#801). A static shell served on a loopback bind,
// like the other settings pages. It contains no token and no decision data:
// the script reads the queue from the API and builds every element with
// textContent, so nothing from the manifest or ledger is parsed as markup.

export const OWNER_DECISIONS_PAGE_HREF = "/settings/owner-decisions";

const STYLE = `
    :root { color-scheme: dark; --bg:#14110e; --panel:#1f1a15; --line:#4a3d2c; --text:#efe6d6; --dim:#b5a78f; --amber:#e0a84a; --ok:#7fbf7f; --bad:#e07a6a; --warn:#e0c05a; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width:920px; margin:0 auto; padding:16px; }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
    .tab { padding:8px 12px; border:1px solid var(--line); border-radius:6px; color:var(--dim); text-decoration:none; min-height:44px; display:inline-flex; align-items:center; }
    .tab[aria-current="page"] { color:var(--text); border-color:var(--amber); }
    h1 { font-size:1.5rem; margin:0 0 8px; }
    h2 { font-size:1.15rem; margin:0; }
    .lede, .note { color:var(--dim); margin:0 0 12px; }
    #banner { border:1px solid var(--warn); border-radius:8px; padding:12px; margin:0 0 16px; }
    #banner[hidden] { display:none; }
    .tokens { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); margin-bottom:16px; }
    label { display:block; color:var(--dim); }
    input, textarea { display:block; width:100%; margin-top:6px; min-height:44px; padding:8px; font:16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#1c1612; color:var(--text); border:1px solid var(--line); border-radius:6px; }
    .card[hidden] { display:none; }
    .card { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:16px; margin-bottom:16px; }
    .card header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; margin-bottom:8px; }
    .badge { padding:2px 10px; border-radius:999px; border:1px solid var(--line); font-size:.85rem; white-space:nowrap; }
    .badge[data-status="READY"] { border-color:var(--amber); color:var(--amber); }
    .badge[data-status="APPROVED"], .badge[data-status="EXECUTED"] { border-color:var(--ok); color:var(--ok); }
    .badge[data-status="REJECTED"], .badge[data-status="EXPIRED"] { border-color:var(--bad); color:var(--bad); }
    .badge[data-status="CHANGES_REQUESTED"] { border-color:var(--warn); color:var(--warn); }
    .risk { color:var(--bad); font-weight:600; }
    dl { margin:0; display:grid; gap:4px 12px; grid-template-columns:minmax(110px, max-content) 1fr; }
    dt { color:var(--dim); }
    dd { margin:0; overflow-wrap:anywhere; }
    ul { margin:0; padding-left:20px; }
    a { color:var(--amber); }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    button { min-height:44px; padding:8px 16px; border-radius:6px; border:1px solid var(--line); background:#2a2219; color:var(--text); font:inherit; cursor:pointer; flex:1 1 140px; }
    button[data-choice="approve"] { border-color:var(--ok); }
    button[data-choice="reject"] { border-color:var(--bad); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .result { margin-top:8px; min-height:1.5em; }
    @media (max-width:560px) { dl { grid-template-columns:1fr; } dt { margin-top:6px; } }
`;

const SCRIPT = `
    const byId = (id) => document.getElementById(id);
    const el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const serviceToken = byId("service-token");
    const approvalToken = byId("approval-token");
    window.addEventListener("pagehide", () => { serviceToken.value = ""; approvalToken.value = ""; });
    const STATUS_WORDS = { NOT_READY: "Not ready", READY: "Ready for your decision", APPROVED: "Approved", REJECTED: "Rejected", CHANGES_REQUESTED: "Changes requested", EXPIRED: "Expired", EXECUTED: "Executed" };
    const CHOICES = [["approve", "Approve"], ["request-changes", "Request changes"], ["reject", "Reject"]];
    let queue = null;

    function row(list, term, value) {
      list.append(el("dt", term));
      const dd = el("dd");
      if (value instanceof Node) dd.append(value); else dd.textContent = value;
      list.append(dd);
    }
    function bullets(items) {
      const list = el("ul");
      items.forEach((item) => list.append(item instanceof Node ? item : el("li", item)));
      return list;
    }
    function allowed(card, choice) {
      if (!queue.decisionsAvailable) return false;
      if (choice === "approve") return card.status === "READY" && queue.subjectVerification === "live-probe";
      if (card.status === "APPROVED") return !(card.execution && card.execution.status === "indeterminate");
      return card.status === "READY" || card.status === "NOT_READY";
    }

    function render() {
      const banner = byId("banner");
      banner.hidden = queue.decisionsAvailable;
      banner.textContent = queue.decisionsAvailable ? "" : "Read-only. " + (queue.unavailableReason || "");
      byId("generated").textContent = "Read at " + queue.generatedAt + ". " + (queue.subjectVerification === "live-probe" ? "Before an approval is recorded, each pull request, issue and branch on the card is checked against GitHub; if any has changed or cannot be checked, the approval is refused." : "No live check is available on this runtime, so approvals are refused.");
      byId("start-ledger").hidden = queue.ledgerState !== "not-started";
      const mount = byId("cards");
      mount.replaceChildren();
      queue.cards.forEach((card) => {
        const entry = card.entry;
        const section = el("section", undefined, "card");
        section.dataset.decision = entry.id;
        const header = el("header");
        header.append(el("h2", entry.title));
        const badge = el("span", STATUS_WORDS[card.status] || card.status, "badge");
        badge.dataset.status = card.status;
        header.append(badge);
        section.append(header);
        const details = el("dl");
        row(details, "What you decide", entry.proposedAction);
        row(details, "Consequence", entry.consequence);
        row(details, "Exact scope", entry.scope);
        row(details, "Environment", entry.environment);
        if (entry.risk === "high") row(details, "Risk", el("span", "High: " + entry.highRiskKind + ". Needs its own typed confirmation.", "risk"));
        const linkList = (items) => bullets(items.map((item) => {
          const li = el("li");
          const link = el("a", item.label);
          link.href = item.url;
          link.rel = "noreferrer noopener";
          link.target = "_blank";
          li.append(link, " (pinned at " + item.revision + ")");
          return li;
        }));
        row(details, "Bound to", linkList(card.links.subjects));
        row(details, "Undo", entry.rollback);
        row(details, "Expires", entry.expiresAt);
        row(details, "Evidence", card.links.evidence.length > 0 ? linkList(card.links.evidence) : "None attached.");
        if (card.blockedBy.length > 0) row(details, "Still missing", bullets(card.blockedBy));
        if (card.decision) row(details, "Your decision", card.decision.choice + " at " + card.decision.recordedAt + (card.decision.note ? " (" + card.decision.note + ")" : ""));
        if (card.execution) row(details, "Execution", (card.execution.status === "indeterminate" ? "UNRESOLVED: it is not known whether this ran" : card.execution.status) + " at " + card.execution.recordedAt + (card.execution.reference ? " (" + card.execution.reference + ")" : ""));
        else if (card.status === "APPROVED") row(details, "Execution", "Not reported yet. Approval does not run anything.");
        if (card.supersededDecisions > 0) row(details, "Earlier decisions", card.supersededDecisions + " recorded against an older version of this card. They no longer apply.");
        section.append(details);

        let confirmField = null;
        if (card.confirmationPhrase && allowed(card, "approve")) {
          const label = el("label", 'To approve, type "' + card.confirmationPhrase + '"');
          confirmField = el("input");
          confirmField.autocomplete = "off";
          confirmField.spellcheck = false;
          label.append(confirmField);
          section.append(label);
        }
        const noteLabel = el("label", "Note (optional, kept in the audit trail)");
        const note = el("textarea");
        note.rows = 2;
        note.maxLength = 1000;
        noteLabel.append(note);
        const actions = el("div", undefined, "actions");
        const result = el("p", "", "result");
        result.setAttribute("role", "status");
        const buttons = CHOICES.map(([choice, word]) => {
          const button = el("button", word);
          button.type = "button";
          button.dataset.choice = choice;
          button.disabled = !allowed(card, choice);
          // One key per button per page load: a double click repeats the same request.
          const idempotencyKey = crypto.randomUUID();
          button.addEventListener("click", () => decide(card, choice, idempotencyKey, confirmField, note, buttons, result));
          actions.append(button);
          return button;
        });
        if (buttons.some((button) => !button.disabled)) section.append(noteLabel);
        section.append(actions, result);
        mount.append(section);
      });
      const excluded = byId("excluded");
      excluded.replaceChildren(...queue.excluded.map((item) => el("li", "#" + item.issue + ": " + item.reason)));
    }

    async function decide(card, choice, idempotencyKey, confirmField, note, buttons, result) {
      if (!serviceToken.value || !approvalToken.value) {
        result.textContent = "Enter the service token and the approval token first. Nothing was recorded.";
        return;
      }
      buttons.forEach((button) => { button.disabled = true; });
      result.textContent = "Recording...";
      const body = { expectedDigest: card.actionDigest, decision: choice, idempotencyKey, approvalToken: approvalToken.value };
      if (confirmField && choice === "approve") body.confirmation = confirmField.value;
      if (note.value.trim()) body.note = note.value.trim();
      try {
        const response = await fetch("/api/v1/owner-decisions/" + encodeURIComponent(card.entry.id) + "/decisions", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + serviceToken.value },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          result.textContent = (payload.detail || "The decision was refused.") + " Nothing was recorded.";
          await load(false);
          return;
        }
        await load(false);
        const fresh = document.querySelector('[data-decision="' + card.entry.id + '"] .result');
        if (fresh) fresh.textContent = payload.data.replayed ? "Already recorded. Nothing new was written." : "Recorded. This records your decision only; it does not run anything.";
      } catch {
        result.textContent = "The request did not complete. Reload to see whether it was recorded.";
      }
    }

    async function load(showError) {
      try {
        const headers = { accept: "application/json" };
        if (serviceToken.value) headers.authorization = "Bearer " + serviceToken.value;
        const response = await fetch("/api/v1/owner-decisions", { headers });
        if (!response.ok) throw new Error("status " + response.status);
        queue = (await response.json()).data;
        render();
      } catch {
        if (showError) {
          const banner = byId("banner");
          banner.hidden = false;
          banner.textContent = "The decision queue could not be read from this runtime. Nothing can be decided here.";
        }
      }
    }
    byId("start-button").addEventListener("click", async () => {
      const result = byId("start-result");
      if (!serviceToken.value || !approvalToken.value) {
        result.textContent = "Enter the service token and the approval token first. Nothing was changed.";
        return;
      }
      try {
        const response = await fetch("/api/v1/owner-decisions/ledger", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + serviceToken.value },
          body: JSON.stringify({ approvalToken: approvalToken.value, confirmation: byId("start-confirm").value }),
        });
        const payload = await response.json().catch(() => ({}));
        result.textContent = response.ok ? "A new, empty ledger was started." : (payload.detail || "Refused.") + " Nothing was changed.";
        await load(false);
      } catch {
        result.textContent = "The request did not complete. Reload to see the current state.";
      }
    });
    byId("reload").addEventListener("click", () => load(true));
    load(true);
`;

export function renderOwnerDecisionsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Owner decisions - Jarvis</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <nav aria-label="Settings">
      <a class="tab" href="/hud">HUD</a>
      <a class="tab" href="/settings/credentials">Credentials</a>
      <a class="tab" href="/settings/limits">Limits</a>
      <a class="tab" href="/settings/danger">Danger zone</a>
      <a class="tab" href="${OWNER_DECISIONS_PAGE_HREF}" aria-current="page">Owner decisions</a>
    </nav>
    <h1>Owner decisions</h1>
    <p class="lede">Every decision that is waiting on you, in one place. A click records your answer in the audit trail. It does not merge, deploy, send or switch anything on; the existing approval, review and deployment gates still apply to the work itself.</p>
    <p id="banner" role="alert" hidden></p>
    <div class="tokens">
      <label>Service token
        <input id="service-token" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <label>Approval token
        <input id="approval-token" type="password" autocomplete="off" spellcheck="false" />
      </label>
    </div>
    <p class="note">Both tokens stay in these fields until you leave the page. They are not written to browser storage. Without them the queue is read-only.</p>
    <p class="note"><span id="generated"></span> <button id="reload" type="button" style="flex:none; min-height:36px; padding:4px 12px;">Reload</button></p>
    <section class="card" id="start-ledger" hidden>
      <h2>No decision ledger on this runtime</h2>
      <p class="note">If this runtime was restored from a backup, stop here and restore <code>jarvis-owner-decisions.jsonl</code> and its checkpoint file first; starting a new ledger would hide every earlier decision. Only start a new ledger on a runtime that has never recorded one.</p>
      <label>To start a new, empty ledger, type "START NEW LEDGER"
        <input id="start-confirm" autocomplete="off" spellcheck="false" />
      </label>
      <div class="actions"><button id="start-button" type="button">Start a new ledger</button></div>
      <p class="result" id="start-result" role="status"></p>
    </section>
    <div id="cards"></div>
    <section class="card">
      <h2>Not in this queue</h2>
      <ul id="excluded"></ul>
    </section>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;
}
