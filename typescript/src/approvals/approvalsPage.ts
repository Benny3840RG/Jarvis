// Approvals page. A static shell served on a loopback bind, like the owner
// decisions page. It contains no token and no action data: the script reads
// staged ToolActions from the existing tool-action API and builds every
// element with textContent, so nothing from an action is parsed as markup.
//
// It adds no authority. Every call goes to the existing governed routes with
// the service token, and approving still needs the separately held approval
// token, typed by the owner and never written to browser storage.

export const APPROVALS_PAGE_HREF = "/settings/approvals";

const STYLE = `
    :root { color-scheme: dark; --bg:#14110e; --panel:#1f1a15; --line:#4a3d2c; --text:#efe6d6; --dim:#b5a78f; --amber:#e0a84a; --ok:#7fbf7f; --bad:#e07a6a; --warn:#e0c05a; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width:920px; margin:0 auto; padding:16px; }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
    .tab { padding:8px 12px; border:1px solid var(--line); border-radius:6px; color:var(--dim); text-decoration:none; min-height:44px; display:inline-flex; align-items:center; }
    .tab[aria-current="page"] { color:var(--text); border-color:var(--amber); }
    h1 { font-size:1.5rem; margin:0 0 8px; }
    h2 { font-size:1.15rem; margin:16px 0 8px; }
    .lede, .note { color:var(--dim); margin:0 0 12px; }
    #banner { border:1px solid var(--warn); border-radius:8px; padding:12px; margin:0 0 16px; }
    #banner[hidden] { display:none; }
    .tokens { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); margin-bottom:12px; }
    label { display:block; color:var(--dim); }
    input { display:block; width:100%; margin-top:6px; min-height:44px; padding:8px; font:16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#1c1612; color:var(--text); border:1px solid var(--line); border-radius:6px; }
    .card { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:16px; margin-bottom:12px; }
    .what { font-size:1.05rem; margin:0 0 8px; overflow-wrap:anywhere; }
    .badge { display:inline-block; padding:2px 10px; border-radius:999px; border:1px solid var(--line); font-size:.85rem; margin-bottom:8px; }
    .badge[data-state="proposed"] { border-color:var(--amber); color:var(--amber); }
    .badge[data-state="approved"] { border-color:var(--ok); color:var(--ok); }
    dl { margin:0; display:grid; gap:4px 12px; grid-template-columns:minmax(110px, max-content) 1fr; }
    dt { color:var(--dim); }
    dd { margin:0; overflow-wrap:anywhere; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.9rem; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    button { min-height:44px; padding:8px 16px; border-radius:6px; border:1px solid var(--line); background:#2a2219; color:var(--text); font:inherit; cursor:pointer; flex:1 1 140px; }
    button[data-act="approve"], button[data-act="run"] { border-color:var(--ok); }
    button[data-act="reject"] { border-color:var(--bad); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .result { margin-top:8px; min-height:1.5em; }
    .result[data-tone="ok"] { color:var(--ok); }
    .result[data-tone="bad"] { color:var(--bad); }
    .empty { color:var(--dim); }
    a { color:var(--amber); }
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
    const projectKey = byId("project-key");
    window.addEventListener("pagehide", () => { serviceToken.value = ""; approvalToken.value = ""; });
    const banner = (message) => { const node = byId("banner"); node.hidden = !message; node.textContent = message || ""; };
    const problem = (data, status) => {
      if (data && typeof data.detail === "string" && data.detail) return data.detail;
      if (data && typeof data.title === "string" && data.title) return data.title;
      return "The request failed (HTTP " + status + ").";
    };
    const actionsPath = () => "/api/v1/projects/" + encodeURIComponent(projectKey.value.trim()) + "/tool-actions";
    async function api(method, path, body) {
      const headers = { accept: "application/json", authorization: "Bearer " + serviceToken.value };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      if (!response.ok) throw new Error(problem(data, response.status));
      return data;
    }
    // What the action does, in the owner's words when NOLAN staged it.
    function describe(action) {
      const rationale = typeof action.rationale === "string" ? action.rationale : "";
      const spoken = /^Voice safe write [^:]+: (.+)$/.exec(rationale);
      if (spoken) return spoken[1];
      return rationale || action.tool + ":" + action.operation;
    }
    function detail(list, term, value) {
      list.append(el("dt", term), el("dd", value));
    }
    function card(action) {
      const node = el("section", undefined, "card");
      const badge = el("span", action.state === "proposed" ? "Waiting for you" : "Approved", "badge");
      badge.dataset.state = action.state;
      node.append(badge, el("p", describe(action), "what"));
      const list = el("dl");
      detail(list, "Operation", action.tool + ":" + action.operation);
      detail(list, "Arguments", JSON.stringify(action.arguments));
      detail(list, "Staged", String(action.createdAt || ""));
      if (action.destructive) detail(list, "Destructive", "yes");
      node.append(list);
      const result = el("p", "", "result");
      result.setAttribute("role", "status");
      const buttons = el("div", undefined, "actions");
      const say = (message, tone) => { result.textContent = message; if (tone) result.dataset.tone = tone; else delete result.dataset.tone; };
      const busy = (on) => { for (const button of buttons.querySelectorAll("button")) button.disabled = on; };
      const run = async () => {
        const receipt = await api("POST", actionsPath() + "/" + encodeURIComponent(action.actionId) + "/execute", { idempotencyKey: "approvals-page:" + action.actionId });
        if (receipt && receipt.status === "succeeded") { say("Done. The change has been made.", "ok"); return; }
        const code = receipt && receipt.errorCode ? " (" + receipt.errorCode + ")" : "";
        say("Not done: execution " + String(receipt && receipt.status) + code + ".", "bad");
      };
      if (action.state === "proposed") {
        const approve = el("button", "Approve and run");
        approve.type = "button";
        approve.dataset.act = "approve";
        approve.addEventListener("click", async () => {
          if (!serviceToken.value || !approvalToken.value) { say("Enter the service token and the approval token first.", "bad"); return; }
          busy(true);
          say("Approving…");
          try {
            const approved = await api("POST", actionsPath() + "/" + encodeURIComponent(action.actionId) + "/approve", { expectedRevision: action.baseRevision, approvalToken: approvalToken.value });
            if (!approved || approved.state !== "approved") { say("Not approved: the action is " + String(approved && approved.state) + ".", "bad"); return; }
            say("Approved. Running…");
            await run();
          } catch (error) {
            say(error instanceof Error ? error.message : String(error), "bad");
          } finally {
            busy(false);
          }
        });
        const reject = el("button", "Reject");
        reject.type = "button";
        reject.dataset.act = "reject";
        reject.addEventListener("click", async () => {
          if (!serviceToken.value) { say("Enter the service token first.", "bad"); return; }
          busy(true);
          try {
            await api("POST", actionsPath() + "/" + encodeURIComponent(action.actionId) + "/reject", { reason: "Rejected on the Approvals page." });
            say("Rejected. Nothing was changed.", "ok");
          } catch (error) {
            say(error instanceof Error ? error.message : String(error), "bad");
          } finally {
            busy(false);
          }
        });
        buttons.append(approve, reject);
      } else {
        const again = el("button", "Run");
        again.type = "button";
        again.dataset.act = "run";
        again.addEventListener("click", async () => {
          if (!serviceToken.value) { say("Enter the service token first.", "bad"); return; }
          busy(true);
          try { await run(); } catch (error) { say(error instanceof Error ? error.message : String(error), "bad"); } finally { busy(false); }
        });
        buttons.append(again);
      }
      node.append(buttons, result);
      return node;
    }
    function fill(id, actions, emptyText) {
      const target = byId(id);
      target.replaceChildren();
      if (actions.length === 0) { target.append(el("p", emptyText, "empty")); return; }
      for (const action of actions) target.append(card(action));
    }
    async function load() {
      banner("");
      if (!serviceToken.value) { banner("Enter the service token to load staged actions."); return; }
      if (!projectKey.value.trim()) { banner("Enter the project key."); return; }
      try {
        const [proposed, approved] = await Promise.all([
          api("GET", actionsPath() + "?state=proposed&limit=100"),
          api("GET", actionsPath() + "?state=approved&limit=100"),
        ]);
        fill("proposed", Array.isArray(proposed) ? proposed : [], "Nothing is waiting for your approval.");
        fill("approved", Array.isArray(approved) ? approved : [], "No approved actions.");
        byId("loaded").textContent = "Loaded " + new Date().toLocaleTimeString() + ".";
      } catch (error) {
        banner(error instanceof Error ? error.message : String(error));
      }
    }
    byId("load").addEventListener("click", load);
`;

export function renderApprovalsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Approvals - Jarvis</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <nav aria-label="Settings">
      <a class="tab" href="/hud">HUD</a>
      <a class="tab" href="${APPROVALS_PAGE_HREF}" aria-current="page">Approvals</a>
      <a class="tab" href="/settings/owner-decisions">Owner decisions</a>
      <a class="tab" href="/settings/credentials">Credentials</a>
    </nav>
    <h1>Approvals</h1>
    <p class="lede">Changes NOLAN (or anything else) has staged for your approval. Nothing on this page happens until you press a button: "Approve and run" approves the exact action shown with your approval token and then runs it once; "Reject" discards it. Each card shows what was read back to you and the exact operation and arguments that will run.</p>
    <p id="banner" role="alert" hidden></p>
    <div class="tokens">
      <label>Service token
        <input id="service-token" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <label>Approval token
        <input id="approval-token" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <label>Project key
        <input id="project-key" value="nolan-voice" autocomplete="off" spellcheck="false" />
      </label>
    </div>
    <p class="note">Both tokens stay in these fields until you leave the page. They are not written to browser storage. NOLAN's spoken changes are staged on the <code>nolan-voice</code> project unless <code>JARVIS_VOICE_PROJECT_KEY</code> says otherwise.</p>
    <p class="note"><button id="load" type="button" style="flex:none; min-height:36px; padding:4px 12px;">Load staged actions</button> <span id="loaded"></span></p>
    <h2>Waiting for your approval</h2>
    <div id="proposed"><p class="empty">Enter the service token and load.</p></div>
    <h2>Approved</h2>
    <p class="note">Running an approved action that has already run returns its original result and changes nothing.</p>
    <div id="approved"></div>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;
}
