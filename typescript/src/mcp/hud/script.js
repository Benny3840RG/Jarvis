
      (() => {
        "use strict";
        const state = { status: null, generalSettings: null, lastStatusAt: 0, tasks: [], reminders: [], tasksLoaded: false, remindersLoaded: false, brief: null, quotes: [], quoteRegisterStatus: "unavailable", counts: { activeTasks: 0, completedTasks: 0, reminders: 0 }, captureMode: "task", activities: [], selectedQuoteSummary: null, selectedQuote: null, quoteDetailState: "empty", quoteRequestGeneration: 0, inbox: null, activity: null, liveWork: null, credentials: null, approvals: null };
        const STATUS_STALE_MS = 45000;
        let rpcId = 0;
        let healthCheckInFlight = false;
        let bridgeInitialised = false;
        let toastTimer = null;
        const pending = new Map();
        const byId = (id) => document.getElementById(id);
        // BEGIN console display preferences
        const CONSOLE_DISPLAY_KEYS = Object.freeze({
          theme: "console.theme",
          contrast: "console.contrast",
          motion: "console.motion",
        });
        const CONSOLE_DISPLAY_DEFAULTS = Object.freeze({
          theme: "system",
          contrast: "default",
          motion: "system",
        });
        function consoleDisplayChoice(value, allowed, fallback) {
          return allowed.includes(value) ? value : fallback;
        }
        function readConsoleDisplayPreferences(storage) {
          return {
            theme: consoleDisplayChoice(storage.getItem(CONSOLE_DISPLAY_KEYS.theme), ["system", "light", "dark"], CONSOLE_DISPLAY_DEFAULTS.theme),
            contrast: consoleDisplayChoice(storage.getItem(CONSOLE_DISPLAY_KEYS.contrast), ["default", "increase"], CONSOLE_DISPLAY_DEFAULTS.contrast),
            motion: consoleDisplayChoice(storage.getItem(CONSOLE_DISPLAY_KEYS.motion), ["system", "reduce"], CONSOLE_DISPLAY_DEFAULTS.motion),
          };
        }
        function writeConsoleDisplayPreferences(storage, preferences) {
          if (!preferences) return false;
          const theme = preferences.theme;
          const contrast = preferences.contrast;
          const motion = preferences.motion;
          if (!["system", "light", "dark"].includes(theme)) return false;
          if (!["default", "increase"].includes(contrast)) return false;
          if (!["system", "reduce"].includes(motion)) return false;
          storage.setItem(CONSOLE_DISPLAY_KEYS.theme, theme);
          storage.setItem(CONSOLE_DISPLAY_KEYS.contrast, contrast);
          storage.setItem(CONSOLE_DISPLAY_KEYS.motion, motion);
          return true;
        }
        function applyConsoleDisplayPreferences(preferences, root) {
          root.dataset.consoleTheme = preferences.theme;
          root.dataset.consoleContrast = preferences.contrast;
          root.dataset.consoleMotion = preferences.motion;
        }
        const consoleDisplayPreferences = {
          keys: CONSOLE_DISPLAY_KEYS,
          defaults: CONSOLE_DISPLAY_DEFAULTS,
          read: readConsoleDisplayPreferences,
          write: writeConsoleDisplayPreferences,
          apply: applyConsoleDisplayPreferences,
        };
        // END console display preferences
        function loadSavedDisplayPreferences() {
          try {
            return readConsoleDisplayPreferences(localStorage);
          } catch {
            return { ...CONSOLE_DISPLAY_DEFAULTS };
          }
        }
        function readDisplayForm() {
          const selected = document.querySelector('input[name="console-theme"]:checked');
          return {
            theme: selected ? selected.value : "",
            contrast: byId("console-contrast").checked ? "increase" : "default",
            motion: byId("console-motion").checked ? "reduce" : "system",
          };
        }
        function syncDisplayForm(preferences) {
          document.querySelectorAll('input[name="console-theme"]').forEach((input) => {
            input.checked = input.value === preferences.theme;
          });
          byId("console-contrast").checked = preferences.contrast === "increase";
          byId("console-motion").checked = preferences.motion === "reduce";
        }
        function saveDisplayPreferences() {
          const status = byId("display-save-status");
          let saved = false;
          try {
            saved = writeConsoleDisplayPreferences(localStorage, readDisplayForm());
            if (saved) applyConsoleDisplayPreferences(readConsoleDisplayPreferences(localStorage), document.documentElement);
          } catch {
            saved = false;
          }
          text(status, saved ? "Display preferences saved on this console." : "Display preferences were not saved.");
          if (saved) toast("Display preferences saved.");
        }
        const text = (el, value) => { el.textContent = value == null ? "" : String(value); };
        function notify(method, params) { window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*"); }
        // On the browser HUD (/hud) these buttons write through the same-origin REST routes.
        const HUD_HTTP_WRITES = {
          create_task: (args) => ({ path: "/api/v1/tasks", body: { title: args.title, category: args.category }, idempotent: true }),
          create_reminder: (args) => ({ path: "/api/v1/reminders", body: Object.assign({ title: args.title }, args.due ? { due: args.due } : {}), idempotent: true }),
          create_errand: (args) => ({ path: "/api/v1/errands", body: { title: args.title } }),
          complete_task: (args) => ({ path: "/api/v1/tasks/" + encodeURIComponent(String(args.taskId || "")) + "/complete" }),
          // The HUD only ever ticks errands off; the tokenless route can do nothing else.
          update_errand: (args) => { if (args.status !== "done") throw new Error("Only ticking off an errand works here."); return { path: "/api/v1/errands/" + encodeURIComponent(String(args.errandId || "")) + "/complete" }; },
        };
        function hudJson(path, init) {
          return fetch(path, Object.assign({ credentials: "same-origin" }, init)).then((response) => {
            if (!response.ok) throw new Error("Request failed (" + response.status + ")");
            return response.status === 204 ? null : response.json();
          });
        }
        function hudIdempotencyKey() {
          try { if (window.crypto && typeof window.crypto.randomUUID === "function") return "hud-" + window.crypto.randomUUID(); } catch { /* fall through */ }
          return "hud-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
        }
        async function hudHttpWrite(name, args) {
          const call = HUD_HTTP_WRITES[name](args);
          const headers = { "content-type": "application/json", accept: "application/json" };
          if (call.idempotent) headers["idempotency-key"] = hudIdempotencyKey();
          const written = await hudJson(call.path, { method: "POST", headers, body: JSON.stringify(call.body || {}) });
          const lists = await Promise.all([hudJson("/api/v1/tasks", { headers: { accept: "application/json" } }), hudJson("/api/v1/reminders", { headers: { accept: "application/json" } })]);
          return { structuredContent: { tasks: (lists[0] && lists[0].data) || [], reminders: (lists[1] && lists[1].data) || [], created: (written && written.data) || null } };
        }
        function request(method, params, timeoutMs = 0) {
          if (typeof location !== "undefined" && location.pathname === "/hud") {
            if (method === "tools/call" && params && params.name === "show_jarvis_dashboard") {
              return fetch("/api/v1/hud/snapshot", { headers: { accept: "application/json" } }).then((response) => {
                if (!response.ok) throw new Error("Snapshot unavailable");
                return response.json().then((data) => ({ structuredContent: data }));
              });
            }
            if (method === "tools/call" && params && HUD_HTTP_WRITES[params.name]) return hudHttpWrite(params.name, params.arguments || {});
            if (method === "tools/call") return Promise.reject(new Error("This preview is read-only."));
            return Promise.resolve({});
          }
          return new Promise((resolve, reject) => {
            const id = ++rpcId;
            const timer = timeoutMs > 0 ? setTimeout(() => {
              pending.delete(id);
              reject(new Error("Request timed out"));
            }, timeoutMs) : null;
            const settle = (fn) => (value) => { if (timer !== null) clearTimeout(timer); fn(value); };
            pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
            window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
          });
        }
        function toast(message, error = false) { const el = byId("toast"); text(el, message); el.classList.toggle("error", error); el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000); }
        function activity(title, detail) { state.activities.unshift({ title, detail, at: new Date() }); state.activities = state.activities.slice(0, 7); renderActivity(); }
        function structured(result) { return result && typeof result === "object" && result.structuredContent ? result.structuredContent : result; }
        function recalc() { state.counts = { activeTasks: state.tasks.filter((task) => !task.completed).length, completedTasks: state.tasks.filter((task) => task.completed).length, reminders: state.reminders.length }; }
        function isConnectionStale(lastUpdateAt, now, thresholdMs) { return lastUpdateAt === 0 || now - lastUpdateAt > thresholdMs; }
        async function checkConnectionHealth(force = false) {
          if (!bridgeInitialised || document.visibilityState !== "visible" || healthCheckInFlight) return;
          if (!force && !isConnectionStale(state.lastStatusAt, Date.now(), STATUS_STALE_MS)) return;
          healthCheckInFlight = true;
          const observedAt = state.lastStatusAt;
          const observedStatus = state.status;
          try {
            const result = await request("tools/call", { name: "show_jarvis_dashboard", arguments: {} }, 10000);
            const data = structured(result);
            if (!data?.status || typeof data.status !== "object") throw new Error("Status unavailable");
            if (state.lastStatusAt === observedAt && state.status === observedStatus) update(result);
          } catch {
            if (state.lastStatusAt === observedAt && state.status === observedStatus && state.status !== null) {
              state.status = null;
              state.lastStatusAt = 0;
              render();
            }
          } finally {
            healthCheckInFlight = false;
          }
        }
        function update(result) { const data = structured(result); if (!data || typeof data !== "object") return; if (data.status && typeof data.status === "object") { state.status = data.status; state.lastStatusAt = Date.now(); } if (data.settings && data.settings.timezone && typeof data.settings.timezone === "object") state.generalSettings = data.settings; if (Array.isArray(data.tasks)) { state.tasks = data.tasks; state.tasksLoaded = true; } if (Array.isArray(data.reminders)) { state.reminders = data.reminders; state.remindersLoaded = true; } if (data.brief && typeof data.brief === "object") state.brief = data.brief; if (data.quoteRegister && typeof data.quoteRegister === "object") { state.quoteRegisterStatus = data.quoteRegister.status === "ready" ? "ready" : "unavailable"; state.quotes = Array.isArray(data.quoteRegister.quotes) ? data.quoteRegister.quotes : []; } if ("inbox" in data) state.inbox = data.inbox; if ("activity" in data) state.activity = data.activity; if ("liveWork" in data) state.liveWork = data.liveWork; if ("credentials" in data) state.credentials = data.credentials; if ("approvals" in data) state.approvals = data.approvals; else if (data.counts && typeof data.counts === "object") state.approvals = null; if (data.counts && typeof data.counts === "object") state.counts = data.counts; else recalc(); render(); }
        window.addEventListener("message", (event) => { if (event.source !== window.parent) return; const message = event.data; if (!message || message.jsonrpc !== "2.0") return; if (typeof message.id === "number") { const waiting = pending.get(message.id); if (!waiting) return; pending.delete(message.id); if (message.error) waiting.reject(message.error); else waiting.resolve(message.result); return; } if (message.method === "ui/notifications/tool-result") update(message.params); }, { passive: true });
        const bridgeReady = (async () => { await request("ui/initialize", { appInfo: { name: "jarvis-dashboard", version: "0.2.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" }); notify("ui/notifications/initialized", {}); bridgeInitialised = true; void checkConnectionHealth(true); activity("HUD bridge online", "MCP Apps connection initialised"); })();
        async function callTool(name, args = {}) { await bridgeReady; const result = await request("tools/call", { name, arguments: args }); update(result); return result; }
        const activeTasks = () => state.tasks.filter((task) => !task.completed);
        const completedTasks = () => state.tasks.filter((task) => task.completed).slice().reverse();
        const subtitle = (task) => `${task.category || "personal"} · ${task.completed ? "complete" : "active"}`;
        const reminderTime = (reminder) => reminder.dueRaw || (reminder.dueAt != null ? new Date(reminder.dueAt).toLocaleString("en-AU") : "No due time");
        const reminderDue = (reminder) => reminder.dueAt != null ? reminder.dueAt : Number.MAX_SAFE_INTEGER;
        function empty(message, className = "empty") { const el = document.createElement("div"); el.className = className; text(el, message); return el; }
        function completeButton(task, compact = false) { const button = document.createElement("button"); button.className = compact ? "ghost" : "primary-button"; button.type = "button"; text(button, compact ? "CLEAR" : "✓ CLEAR TASK"); button.addEventListener("click", async () => { button.disabled = true; try { await callTool("complete_task", { taskId: task.id }); activity("Task cleared", task.title); toast(`Completed ${task.title}`); } catch { toast("Could not complete that task.", true); } finally { button.disabled = false; } }); return button; }
        function taskRow(task, compact = false, allowComplete = true) { const row = document.createElement(compact ? "li" : "div"); row.className = compact ? "priority-row" : `board-row${task.completed ? " done" : ""}`; const copy = document.createElement("div"); const title = document.createElement("strong"); const meta = document.createElement("small"); text(title, task.title); text(meta, subtitle(task)); copy.append(title, meta); row.append(copy); if (allowComplete && !task.completed) row.append(completeButton(task, true)); return row; }
        function reminderRow(reminder) { const row = document.createElement("div"); row.className = "reminder-row"; const copy = document.createElement("div"); const title = document.createElement("strong"); const meta = document.createElement("small"); text(title, reminder.title); text(meta, reminderTime(reminder)); copy.append(title, meta); const chip = document.createElement("span"); chip.className = "chip"; text(chip, reminder.dueAt == null ? "NO TIME" : reminder.dueAt < Date.now() ? "OVERDUE" : "SET"); row.append(copy, chip); return row; }
        function fillList(el, items, renderer, message) { el.replaceChildren(); if (!items.length) { el.append(empty(message)); return; } items.forEach((item) => el.append(renderer(item))); }
        function layerEntries() { return Object.entries(state.status?.layers || {}); }
        function layerWeight(status) { return status === "ready" ? 1 : status === "partial" ? 0.68 : status === "inactive" ? 0.34 : 0.08; }
        function renderReadiness() { const layers = layerEntries(); const ready = layers.filter(([, value]) => value.status === "ready").length; const percent = layers.length ? Math.round((ready / layers.length) * 100) : 0; text(byId("ready-layer-count"), `${ready} / ${layers.length || 8} READY`); text(byId("readiness-percent"), `${percent}%`); text(byId("readiness-state"), state.status ? state.status.status.toUpperCase() : "AWAITING STATUS"); byId("readiness-ring").setAttribute("stroke-dasharray", `${percent} ${100 - percent}`); text(byId("nav-system-count"), ready); }
        function renderFocus() { const active = activeTasks(); const current = active[0]; const title = byId("current-task"); const sub = byId("current-subtitle"); const meta = byId("current-meta"); const actions = byId("current-actions"); meta.replaceChildren(); actions.replaceChildren(); if (!current) { text(title, "Deck cleared."); text(sub, "No active task is holding the command queue"); text(byId("mission-state"), "CLEAR"); } else { text(title, current.title); text(sub, subtitle(current).toUpperCase()); text(byId("mission-state"), "ACTIVE"); [current.category || "personal", "DURABLE TASK"].forEach((label) => { const chip = document.createElement("span"); chip.className = "chip"; text(chip, label); meta.append(chip); }); actions.append(completeButton(current)); }
          const total = state.counts.activeTasks + state.counts.completedTasks; const complete = total ? Math.round((state.counts.completedTasks / total) * 100) : 0; byId("mission-progress-ring").setAttribute("stroke-dasharray", `${complete} ${100 - complete}`); fillList(byId("focus-queue"), active.slice(1, 4), (task) => taskRow(task, true), "Nothing queued. The command deck is clear."); text(byId("queue-count"), `${Math.max(0, active.length - 1)} QUEUED`); text(byId("focus-active"), state.counts.activeTasks); text(byId("focus-done"), state.counts.completedTasks); text(byId("focus-reminders"), state.counts.reminders); }
        function renderBoard() { const active = activeTasks(); const done = completedTasks(); fillList(byId("active-list"), active, (task) => taskRow(task), "No active tasks."); fillList(byId("done-list"), done, (task) => taskRow(task, false, false), "No completed tasks yet."); text(byId("board-active-count"), `${active.length} ACTIVE`); text(byId("board-done-count"), `${done.length} COMPLETE`); }
        function timingBuckets() { const now = Date.now(); const day = 86400000; const buckets = [0,0,0,0]; state.reminders.forEach((reminder) => { if (reminder.dueAt == null) buckets[3] += 1; else if (reminder.dueAt <= now) buckets[0] += 1; else if (reminder.dueAt <= now + day) buckets[1] += 1; else buckets[2] += 1; }); return buckets; }
        function renderReminderChart() { const values = timingBuckets(); const max = Math.max(1, ...values); const group = byId("reminder-chart-bars"); group.replaceChildren(); const xs = [75,165,255,347]; values.forEach((value, index) => { const height = Math.max(3, Math.round((value / max) * 180)); const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect"); rect.setAttribute("x", String(xs[index] - 22)); rect.setAttribute("y", String(255 - height)); rect.setAttribute("width", "44"); rect.setAttribute("height", String(height)); rect.setAttribute("rx", "6"); rect.setAttribute("fill", index % 2 ? "var(--green)" : "var(--violet)"); const label = document.createElementNS("http://www.w3.org/2000/svg", "text"); label.setAttribute("x", String(xs[index])); label.setAttribute("y", String(Math.max(35, 246 - height))); label.setAttribute("text-anchor", "middle"); label.setAttribute("fill", "var(--text)"); label.setAttribute("font-size", "13"); label.textContent = String(value); group.append(rect, label); }); }
        function renderReminders() { const reminders = state.reminders.slice().sort((a,b) => reminderDue(a) - reminderDue(b)); fillList(byId("reminder-list"), reminders, reminderRow, "No reminders set."); text(byId("reminders-total"), `${reminders.length} TOTAL`); renderReminderChart(); }
        function point(index, count, radius, centre = 200) { const angle = -Math.PI / 2 + (index * Math.PI * 2) / count; return [centre + Math.cos(angle) * radius, centre + Math.sin(angle) * radius]; }
        function renderRadar() { const entries = layerEntries(); const names = entries.length ? entries.map(([name]) => name) : ["runtime","domains","integration","orchestration","safety","adaptive","autonomy","reliability"]; const values = entries.length ? entries.map(([, value]) => layerWeight(value.status)) : names.map(() => 0.08); const count = names.length; byId("layer-radar-polygon").setAttribute("points", values.map((value,index) => point(index,count,138 * value).join(",")).join(" ")); const grid = byId("radar-grid"); const axes = byId("radar-axes"); const labels = byId("radar-labels"); grid.replaceChildren(); axes.replaceChildren(); labels.replaceChildren(); [0.25,0.5,0.75,1].forEach((scale) => { const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon"); polygon.setAttribute("points", names.map((_,index) => point(index,count,138 * scale).join(",")).join(" ")); grid.append(polygon); }); names.forEach((name,index) => { const [x,y] = point(index,count,138); const line = document.createElementNS("http://www.w3.org/2000/svg", "line"); line.setAttribute("x1","200"); line.setAttribute("y1","200"); line.setAttribute("x2",String(x)); line.setAttribute("y2",String(y)); axes.append(line); const [lx,ly] = point(index,count,160); const label = document.createElementNS("http://www.w3.org/2000/svg", "text"); label.setAttribute("x",String(lx)); label.setAttribute("y",String(ly)); label.setAttribute("text-anchor",lx < 190 ? "end" : lx > 210 ? "start" : "middle"); label.setAttribute("dominant-baseline","middle"); label.textContent = name.toUpperCase(); labels.append(label); }); }
        function renderSystems() {
          const status = state.status;
          const pill = byId("status-pill");
          pill.classList.remove("bad", "pending");
          if (!status) {
            pill.classList.add("pending");
            text(byId("status-label"), "CONNECTING");
            text(byId("system-status"), "UNAVAILABLE");
            text(byId("z-state"), "UNAVAILABLE");
            text(byId("provider"), "UNAVAILABLE");
            text(byId("deployment"), "UNAVAILABLE");
            text(byId("source-version"), "UNAVAILABLE");
            text(byId("timezone"), "UNAVAILABLE");
            text(byId("checked-at"), "");
            byId("layer-grid").replaceChildren();
            byId("integration-grid").replaceChildren();
            text(byId("reasoning-provider"), "UNAVAILABLE");
            text(byId("reasoning-verification"), "WAITING FOR STATUS");
            text(byId("right-provider"), "UNAVAILABLE");
            text(byId("provider-reachability"), "UNAVAILABLE");
            text(byId("provider-authentication"), "UNAVAILABLE");
            text(byId("provider-schema"), "UNAVAILABLE");
            text(byId("provider-version"), "UNAVAILABLE");
            text(byId("provider-link-state"), "CONNECTING");
            text(byId("telemetry-provider"), "UNAVAILABLE");
            text(byId("telemetry-deployment"), "UNAVAILABLE");
            text(byId("telemetry-z-state"), "UNAVAILABLE");
            text(byId("source-pill"), "SOURCE · CONNECTING");
            text(byId("footer-status"), "NOLAN reconnecting · status unavailable");
            renderReadiness();
            renderRadar();
            return;
          }
          const healthy = status.status === "ok";
          const halt = securityHaltWords(status);
          if (!healthy) pill.classList.add("bad");
          text(
            byId("status-label"),
            halt ? "HALTED" : healthy ? "OPERATIONAL" : status.status.toUpperCase()
          );
          text(byId("system-status"), status.status.toUpperCase());
          text(byId("z-state"), status.zState.toUpperCase());
          text(
            byId("provider"),
            `${status.provider?.name || "unknown"} · ${status.provider?.reachability || "unknown"}`
          );
          text(byId("deployment"), status.provider?.deploymentVersion || "development");
          text(byId("source-version"), status.sourceVersion || "unknown");
          text(byId("timezone"), status.timezone || "unknown");
          text(
            byId("checked-at"),
            status.checkedAt
              ? new Date(status.checkedAt).toLocaleTimeString("en-AU")
              : ""
          );
          const grid = byId("layer-grid");
          grid.replaceChildren();
          Object.entries(status.layers || {}).forEach(([name, value]) => {
            const item = document.createElement("div");
            item.className = `layer ${value.status}`;
            const title = document.createElement("b");
            const label = document.createElement("span");
            text(title, name);
            text(label, value.status);
            item.append(title, label);
            grid.append(item);
          });
          const integrationGrid = byId("integration-grid");
          integrationGrid.replaceChildren();
          (Array.isArray(status.integrations) ? status.integrations : []).forEach(
            (integration) => {
              const item = document.createElement("div");
              item.className = "system-item";
              const label = document.createElement("span");
              const value = document.createElement("b");
              text(label, integration.name);
              text(value, integration.status.toUpperCase());
              item.append(label, value);
              integrationGrid.append(item);
            }
          );
          const reasoning = status.reasoning || null;
          const reasoningConfigured = reasoning?.status === "configured";
          text(
            byId("reasoning-provider"),
            reasoningConfigured
              ? `${reasoning.provider || "unknown"} · ${reasoning.model || "unknown"}`
              : "NOT CONFIGURED"
          );
          text(
            byId("reasoning-verification"),
            reasoningConfigured
              ? "CONFIGURATION ONLY / INVOCATION UNVERIFIED"
              : "NOT CONFIGURED"
          );
          const provider = status.provider || {};
          text(byId("right-provider"), `${provider.name || "UNKNOWN"} PERSISTENCE`);
          text(
            byId("provider-reachability"),
            (provider.reachability || "unknown").toUpperCase()
          );
          text(
            byId("provider-authentication"),
            (provider.authentication || "unknown").toUpperCase()
          );
          text(
            byId("provider-schema"),
            (provider.schemaCompatibility || "unknown").toUpperCase()
          );
          text(byId("provider-version"), provider.deploymentVersion || "DEVELOPMENT");
          text(
            byId("provider-link-state"),
            provider.reachability === "ok" ? "LINK ONLINE" : "LINK DEGRADED"
          );
          text(byId("telemetry-provider"), (provider.name || "unknown").toUpperCase());
          text(
            byId("telemetry-deployment"),
            provider.deploymentVersion || "DEVELOPMENT"
          );
          text(byId("telemetry-z-state"), status.zState.toUpperCase());
          text(byId("source-pill"), `SOURCE · ${status.sourceVersion || "UNKNOWN"}`);
          text(
            byId("footer-status"),
            halt
              ? `NOLAN halted · ${halt}`
              : `NOLAN ${status.status} · ${provider.name || "unknown"} persistence`
          );
          renderReadiness();
          renderRadar();
        }
        // `npm run sec -- halt` (#839). Null while dispatch is allowed or the
        // service predates the field; otherwise plain words for the stage.
        function securityHaltWords(status) {
          const halt = status && status.securityHalt;
          if (!halt || halt.dispatch !== "refused") return null;
          if (halt.state === "verified-stopped") return "verified stopped";
          if (halt.state === "acknowledged") {
            const left = Number(halt.unsettledExecutions) || 0;
            return `stopping · ${left} still running`;
          }
          if (halt.state === "requested") return "not acknowledged by the service";
          return "cannot be verified";
        }
        function renderCategories() { const counts = new Map(); state.tasks.forEach((task) => { const category = task.category || "personal"; counts.set(category,(counts.get(category) || 0) + 1); }); const entries = [...counts.entries()].sort((a,b) => b[1] - a[1]).slice(0,5); const max = Math.max(1,...entries.map(([,value]) => value)); const bars = byId("category-bars"); bars.replaceChildren(); if (!entries.length) bars.append(empty("No task-domain data yet.")); else entries.forEach(([category,value]) => { const row = document.createElement("div"); row.className = "category-row"; const name = document.createElement("span"); text(name,category); const track = document.createElement("div"); track.className = "bar-track"; const fill = document.createElement("div"); fill.className = "bar-fill"; fill.style.width = `${Math.round((value / max) * 100)}%`; track.append(fill); const count = document.createElement("b"); text(count,value); row.append(name,track,count); bars.append(row); }); const total = state.counts.activeTasks + state.counts.completedTasks; const percent = total ? Math.round((state.counts.completedTasks / total) * 100) : 0; text(byId("completion-percent"),`${percent}%`); byId("completion-ring").setAttribute("stroke-dasharray",`${percent} ${100 - percent}`); }
        function renderPriorities() { const tasks = activeTasks().slice(0,4); fillList(byId("left-priority-list"),tasks,(task) => taskRow(task,true,false),"No active priorities."); text(byId("priority-count"),`${tasks.length} QUEUED`); }
        function renderRightReminders() { const reminders = state.reminders.slice().sort((a,b) => reminderDue(a) - reminderDue(b)).slice(0,3); const list = byId("right-reminder-list"); list.replaceChildren(); if (!reminders.length) list.append(empty("No reminder contacts.","compact-row empty")); else reminders.forEach((reminder) => { const row = document.createElement("li"); row.className = "compact-row"; const title = document.createElement("strong"); const meta = document.createElement("small"); text(title,reminder.title); text(meta,reminderTime(reminder)); row.append(title,meta); list.append(row); }); text(byId("right-reminder-count"),`${state.reminders.length} TRACKED`); }
        const aud = new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD",minimumFractionDigits:2,maximumFractionDigits:2});
        function operationsRow(titleValue, metaValue) { const row = document.createElement("li"); row.className = "compact-row"; const title = document.createElement("strong"); const meta = document.createElement("small"); text(title,titleValue); text(meta,metaValue); row.append(title,meta); return row; }
        function quotePipelineRow(quote) { const row = document.createElement("li"); row.className = "compact-row"; const button = document.createElement("button"); button.className = "quote-pipeline-button"; button.type = "button"; const title = document.createElement("strong"); const meta = document.createElement("small"); text(title,`#${quote.number}`); text(meta,`${(quote.revisionStatus || "draft").toUpperCase()} · ${(quote.commercialStatus || "open").toUpperCase()} · ${aud.format(quote.total || 0)}`); button.append(title,meta); button.addEventListener("click",() => openQuote(quote)); row.append(button); return row; }
        async function openQuote(summary) {
          const quoteId = summary.quoteId;
          const requestGeneration = ++state.quoteRequestGeneration;
          state.selectedQuoteSummary = summary;
          state.selectedQuote = null;
          state.quoteDetailState = "loading";
          renderQuoteDetail();
          try {
            const result = await callTool("get_quote",{ quoteId });
            if (state.quoteRequestGeneration !== requestGeneration || state.selectedQuoteSummary?.quoteId !== quoteId) return;
            const payload = result && typeof result === "object" && result.structuredContent ? result.structuredContent : result;
            if (result?.isError) {
              const detail = Array.isArray(result.content) ? result.content.map((item) => item?.text || "").join(" ") : "";
              state.quoteDetailState = /not found/i.test(detail) ? "not-found" : "error";
              state.selectedQuote = null;
            } else {
              state.selectedQuote = payload?.quote || null;
              state.quoteDetailState = state.selectedQuote ? "ready" : "not-found";
            }
          } catch (error) {
            if (state.quoteRequestGeneration !== requestGeneration || state.selectedQuoteSummary?.quoteId !== quoteId) return;
            state.selectedQuote = null;
            state.quoteDetailState = error?.status === 404 ? "not-found" : "error";
          }
          if (state.quoteRequestGeneration === requestGeneration) renderQuoteDetail();
        }
        function renderQuoteDetail() {
          const phase = state.quoteDetailState;
          const quote = state.selectedQuote;
          const status = byId("quote-detail-state");
          const retry = byId("quote-detail-retry");
          retry.hidden = phase !== "error" && phase !== "not-found";
          retry.onclick = state.selectedQuoteSummary ? () => openQuote(state.selectedQuoteSummary) : null;
          status.classList?.toggle("error",phase === "error" || phase === "not-found");
          if (phase !== "ready" || !quote) {
            const labels = { empty:"SELECT A REGISTER QUOTE",loading:"LOADING QUOTE","not-found":"QUOTE NOT FOUND",error:"QUOTE READ FAILED" };
            text(status,labels[phase] || labels.empty);
            text(byId("quote-detail-number"),"—");
            text(byId("quote-detail-revision"),"—");
            text(byId("quote-detail-status"),"—");
            text(byId("quote-detail-commercial"),"—");
            text(byId("quote-detail-subtotal"),aud.format(0));
            text(byId("quote-detail-tax"),aud.format(0));
            text(byId("quote-detail-total"),aud.format(0));
            text(byId("quote-detail-valid"),"—");
            text(byId("quote-detail-notes"),phase === "error" ? "The quote could not be loaded. Retry when the connection is ready." : "");
            fillList(byId("quote-detail-items"),[],() => empty(""),phase === "loading" ? "Loading quote details…" : phase === "not-found" ? "That quote is no longer available." : "Choose a finalised open quote above.");
            return;
          }
          const aggregate = quote.aggregate || {};
          const revision = quote.revision || {};
          const items = Array.isArray(revision.lineItems) ? revision.lineItems : [];
          text(status,"READ ONLY");
          text(byId("quote-detail-number"),`#${aggregate.number || "—"}`);
          text(byId("quote-detail-revision"),revision.revision ?? "—");
          text(byId("quote-detail-status"),(revision.status || "unknown").toUpperCase());
          text(byId("quote-detail-commercial"),(aggregate.commercialStatus || "unknown").toUpperCase());
          text(byId("quote-detail-subtotal"),aud.format(revision.subtotal || 0));
          text(byId("quote-detail-tax"),aud.format(revision.tax || 0));
          text(byId("quote-detail-total"),aud.format(revision.total || 0));
          text(byId("quote-detail-valid"),revision.validUntil || "NOT SET");
          text(byId("quote-detail-notes"),revision.notes || "No quote notes.");
          fillList(byId("quote-detail-items"),items,(item) => operationsRow(item.description,`${item.quantity} × ${aud.format(item.unitPrice)}`),"No line items recorded.");
        }
        function renderOperations() { const brief = state.brief; if (!brief) { text(byId("brief-headline"),"Live daily operations will appear here."); text(byId("brief-generated"),"AWAITING BRIEF"); text(byId("nav-operations-count"),0); fillList(byId("operations-project-list"),[],() => empty(""),"No daily brief loaded."); fillList(byId("operations-quote-list"),[],() => empty(""),"No lifecycle quote register loaded."); fillList(byId("operations-maintenance-list"),[],() => empty(""),"No daily brief loaded."); fillList(byId("operations-enquiry-list"),[],() => empty(""),"No daily brief loaded."); fillList(byId("operations-invoice-list"),[],() => empty(""),"No daily brief loaded."); fillList(byId("operations-errand-list"),[],() => empty(""),"No daily brief loaded."); text(byId("brief-enquiry-count"),0); text(byId("brief-unpaid-total"),aud.format(0)); text(byId("brief-errand-count"),0); text(byId("operations-enquiry-count"),"0 OPEN"); text(byId("operations-invoice-count"),"0 UNPAID"); text(byId("operations-errand-count"),"0 TO RUN"); text(byId("brief-scheduled-today"),0); text(byId("operations-scheduled-count"),"0 OVERDUE · 0 TODAY · 0 THIS WEEK"); fillList(byId("operations-scheduled-list"),[],() => empty(""),"No daily brief loaded."); renderQuoteDetail(); return; } const projects = Array.isArray(brief.projects?.active) ? brief.projects.active : []; const registerReady = state.quoteRegisterStatus === "ready"; const summaries = registerReady && Array.isArray(state.quotes) ? state.quotes : []; const pipeline = summaries.filter((quote) => quote.revisionStatus === "finalized" && quote.commercialStatus === "open"); const draftCount = summaries.filter((quote) => quote.revisionStatus === "draft").length; const acceptedTotal = summaries.filter((quote) => quote.commercialStatus === "accepted").reduce((sum,quote) => sum + (quote.total || 0),0); const pipelineTotal = pipeline.reduce((sum,quote) => sum + (quote.total || 0),0); const due = Array.isArray(brief.maintenance?.due) ? brief.maintenance.due : []; const dueSoon = Array.isArray(brief.maintenance?.dueSoon) ? brief.maintenance.dueSoon : []; text(byId("brief-headline"),brief.headline || "Daily brief loaded."); text(byId("brief-generated"),brief.generatedAt ? new Date(brief.generatedAt).toLocaleString("en-AU") : "TIME UNAVAILABLE"); text(byId("brief-reminders-due"),brief.reminders?.dueCount || 0); text(byId("brief-reminders-upcoming"),brief.reminders?.upcomingCount || 0); text(byId("brief-project-count"),brief.projects?.activeCount || 0); text(byId("brief-quote-count"),registerReady ? pipeline.length : "—"); text(byId("brief-draft-count"),registerReady ? draftCount : "—"); text(byId("brief-accepted-total"),registerReady ? aud.format(acceptedTotal) : "—"); const attentionProjectIds = new Set([...projects,...(Array.isArray(brief.scheduled?.overdue) ? brief.scheduled.overdue : []),...(Array.isArray(brief.scheduled?.today) ? brief.scheduled.today : [])].map((project) => project.id)); text(byId("nav-operations-count"),attentionProjectIds.size + pipeline.length + due.length + (brief.enquiries?.openCount || 0) + (brief.invoices?.unpaidCount || 0) + (brief.errands?.openCount || 0)); text(byId("operations-project-count"),`${brief.projects?.activeCount || 0} ACTIVE`); fillList(byId("operations-project-list"),projects,(project) => operationsRow(project.title,(project.status || "active").toUpperCase()),"No active projects."); text(byId("operations-quote-total"),registerReady ? aud.format(pipelineTotal) : "UNAVAILABLE"); fillList(byId("operations-quote-list"),pipeline,quotePipelineRow,registerReady ? "No finalised open quotes." : "Lifecycle quote register unavailable."); const maintenance = [...due.map((asset) => ({...asset,dueLabel:"OVERDUE"})),...dueSoon.map((asset) => ({...asset,dueLabel:"DUE SOON"}))]; text(byId("operations-maintenance-count"),`${brief.maintenance?.dueCount || 0} DUE · ${brief.maintenance?.dueSoonCount || 0} SOON`); fillList(byId("operations-maintenance-list"),maintenance,(asset) => operationsRow(asset.name,`${asset.dueLabel} · ${asset.kind || "equipment"}`),"No scheduled maintenance pressure."); const openEnquiries = Array.isArray(brief.enquiries?.open) ? brief.enquiries.open : []; const enquiryCount = brief.enquiries?.openCount || 0; const unpaidInvoices = Array.isArray(brief.invoices?.unpaid) ? brief.invoices.unpaid : []; const unpaidCount = brief.invoices?.unpaidCount || 0; const unpaidTotal = brief.invoices?.unpaidTotal || 0; text(byId("brief-enquiry-count"),enquiryCount); text(byId("brief-unpaid-total"),aud.format(unpaidTotal)); text(byId("operations-enquiry-count"),`${enquiryCount} OPEN`); fillList(byId("operations-enquiry-list"),openEnquiries,(enquiry) => operationsRow(enquiry.requestedWork || "Enquiry",`${(enquiry.urgency || "standard").toUpperCase()} · ${enquiry.source || "enquiry"}`),"No open enquiries."); text(byId("operations-invoice-count"),`${unpaidCount} UNPAID`); fillList(byId("operations-invoice-list"),unpaidInvoices,(invoice) => operationsRow(`#${invoice.number}`,`${aud.format(invoice.balanceDue || 0)} · ${invoice.clientId || "client"}`),"No unpaid invoices."); const openErrands = Array.isArray(brief.errands?.open) ? brief.errands.open : []; const errandCount = brief.errands?.openCount || 0; text(byId("brief-errand-count"),errandCount); text(byId("operations-errand-count"),`${errandCount} TO RUN`); fillList(byId("operations-errand-list"),openErrands,(errand) => operationsRow(errand.title || "Errand",errand.location?.label ? errand.location.label.toUpperCase() : "NO SET PLACE"),"No errands to run."); const scheduledOverdue = Array.isArray(brief.scheduled?.overdue) ? brief.scheduled.overdue : []; const scheduledToday = Array.isArray(brief.scheduled?.today) ? brief.scheduled.today : []; const scheduledWeek = Array.isArray(brief.scheduled?.thisWeek) ? brief.scheduled.thisWeek : []; const scheduledOverdueCount = brief.scheduled?.overdueCount || 0; const scheduledTodayCount = brief.scheduled?.todayCount || 0; const scheduledWeekCount = brief.scheduled?.thisWeekCount || 0; text(byId("brief-scheduled-today"),scheduledTodayCount); text(byId("operations-scheduled-count"),`${scheduledOverdueCount} OVERDUE · ${scheduledTodayCount} TODAY · ${scheduledWeekCount} THIS WEEK`); const scheduledRows = [...scheduledOverdue.map((project) => ({...project,whenLabel:"OVERDUE"})),...scheduledToday.map((project) => ({...project,whenLabel:"TODAY"})),...scheduledWeek.map((project) => ({...project,whenLabel:"THIS WEEK"}))]; fillList(byId("operations-scheduled-list"),scheduledRows,(project) => operationsRow(project.title || "Job",`${project.whenLabel} · ${(project.status || "active").toUpperCase()}`),"No jobs booked this week."); renderQuoteDetail(); }
        function renderActivity() { const list = byId("activity-list"); list.replaceChildren(); if (!state.activities.length) { list.append(empty("No operator activity yet.","activity-row empty")); return; } state.activities.slice(0,6).forEach((item) => { const row = document.createElement("li"); row.className = "activity-row"; const title = document.createElement("strong"); const meta = document.createElement("small"); text(title,item.title); text(meta,`${item.detail} · ${item.at.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"})}`); row.append(title,meta); list.append(row); }); }
        function inboxHasDegradedSource(inbox) { return inbox.sources.some((source) => source.status === "unavailable" || source.status === "degraded"); }
        function inboxSummaryLabel(inbox) { if (!inbox) return "INBOX UNAVAILABLE"; if (inbox.items.length) return inbox.items.length === 1 ? "1 ITEM NEEDS ATTENTION" : `${inbox.items.length} ITEMS NEED ATTENTION`; return inboxHasDegradedSource(inbox) ? "NO ITEMS FROM AVAILABLE SOURCES" : "NOTHING NEEDS ATTENTION"; }
        function inboxEmptyMessage(inbox) { return inboxHasDegradedSource(inbox) ? "No items from available sources — see source status below for what could not be checked." : "Nothing needs attention right now."; }
        function inboxItemRow(item) { const row = document.createElement("li"); row.className = "inbox-row"; const head = document.createElement("div"); const sev = document.createElement("span"); sev.className = `sev sev-${item.severity}`; text(sev,item.severity); const title = document.createElement("strong"); text(title,item.title); head.append(sev,title); const meta = document.createElement("small"); text(meta,item.explanation); row.append(head,meta); return row; }
        function sourceStatusRow(source) { const row = document.createElement("div"); row.className = "source-status-row"; const name = document.createElement("span"); text(name,source.source); const stateChip = document.createElement("span"); stateChip.className = `state ${source.status}`; text(stateChip,source.status); row.append(name,stateChip); return row; }
        function renderInbox() { const inbox = state.inbox; text(byId("inbox-summary"),inboxSummaryLabel(inbox)); const sourceList = byId("inbox-source-list"); sourceList.replaceChildren(); if (!inbox) { fillList(byId("inbox-item-list"),[],() => empty(""),"Operations inbox could not be reached."); return; } fillList(byId("inbox-item-list"),inbox.items,inboxItemRow,inboxEmptyMessage(inbox)); inbox.sources.forEach((source) => sourceList.append(sourceStatusRow(source))); }
        function activityEventRow(event) { const row = document.createElement("li"); row.className = "activity-row"; const title = document.createElement("strong"); text(title,event.summary); const meta = document.createElement("small"); text(meta,`${event.actor} · ${new Date(event.occurredAt).toLocaleString("en-AU")}`); row.append(title,meta); return row; }
        function renderActivityTimeline() { const activity = state.activity; const statusEl = byId("activity-timeline-status"); if (!activity || activity.status === "unavailable") { text(statusEl,"DURABLE · UNAVAILABLE"); fillList(byId("activity-timeline-list"),[],() => empty(""),!activity ? "Activity timeline could not be reached." : activity.reason || "Activity timeline unavailable."); return; } text(statusEl,`DURABLE · ${activity.events.length} EVENT${activity.events.length === 1 ? "" : "S"}`); fillList(byId("activity-timeline-list"),activity.events,activityEventRow,"No recent activity."); }
        function renderCounts() { recalc(); text(byId("active-count"),state.counts.activeTasks); text(byId("done-count"),state.counts.completedTasks); text(byId("reminder-count"),state.counts.reminders); text(byId("telemetry-queue"),`${state.counts.activeTasks} TASKS`); text(byId("nav-focus-count"),state.counts.activeTasks ? 1 : 0); text(byId("nav-board-count"),state.tasks.length); text(byId("nav-reminder-count"),state.counts.reminders); }
        const LIVE_WORK_KEYS = ["mission", "stage", "issue", "pr", "worker", "review", "ci", "merge", "omega"];
        function liveWorkNodeApply(key, status, detail) { const node = byId(`lw-node-${key}`); ["done", "active", "pending", "blocked", "unavailable"].forEach((name) => node.classList.toggle(name, name === status)); text(byId(`lw-status-${key}`), status ? String(status).toUpperCase() : "—"); text(byId(`lw-detail-${key}`), detail); }
        function liveWorkRailRow(stage) { const node = document.createElement("div"); node.className = "lw-node"; ["done", "active", "pending", "blocked", "unavailable"].forEach((name) => node.classList.toggle(name, name === stage.status)); const label = document.createElement("span"); label.className = "lw-label"; const dot = document.createElement("span"); dot.className = "lw-dot"; const title = document.createElement("span"); text(title, stage.label); label.append(dot, title); const status = document.createElement("b"); status.className = "lw-status"; text(status, stage.status); node.append(label, status); return node; }
        function clearLiveWorkRail(message) { fillList(byId("livework-pipeline"), [], () => empty(""), message); text(byId("livework-bindings"), ""); fillList(byId("livework-omega-failures"), [], () => empty(""), "Readiness not reported."); }
        function renderLiveWork() {
          const lw = state.liveWork;
          const objective = byId("livework-objective");
          const subject = byId("livework-subject");
          const stateEl = byId("livework-state");
          const eventsStatus = byId("livework-events-status");
          if (!lw) {
            clearLiveWorkRail("Live-work pipeline could not be reached.");
            text(objective, "LIVE-WORK LINK UNAVAILABLE");
            text(subject, "The development live-work pipeline could not be reached.");
            text(stateEl, "OFFLINE");
            LIVE_WORK_KEYS.forEach((key) => liveWorkNodeApply(key, "unavailable", "Could not be reached."));
            text(eventsStatus, "UNAVAILABLE");
            fillList(byId("livework-events"), [], () => empty(""), "Mission events could not be reached.");
            text(byId("nav-livework-count"), 0);
            return;
          }
          if (lw.status === "unavailable" || !lw.pipeline) {
            const unavailable = lw.status === "unavailable";
            const detail = unavailable ? lw.reason : "NO MISSION IN FLIGHT";
            clearLiveWorkRail(detail);
            text(objective, unavailable ? "LIVE WORK UNAVAILABLE" : "NO MISSION IN FLIGHT");
            text(subject, detail);
            text(stateEl, unavailable ? "UNAVAILABLE" : "IDLE");
            LIVE_WORK_KEYS.forEach((key) => liveWorkNodeApply(key, unavailable ? "unavailable" : "pending", detail));
            text(eventsStatus, unavailable ? "UNAVAILABLE" : "IDLE");
            fillList(byId("livework-events"), [], () => empty(""), detail);
            text(byId("nav-livework-count"), 0);
            return;
          }
          const pipeline = lw.pipeline;
          text(objective, pipeline.objective || pipeline.subjectId);
          text(subject, [pipeline.repository, pipeline.branch].filter(Boolean).join(" · ") || pipeline.subjectId);
          text(stateEl, pipeline.completionLabel || pipeline.state);
          fillList(byId("livework-pipeline"), pipeline.rail || [], liveWorkRailRow, "Mission stages not reported.");
          text(byId("livework-bindings"), `Subject version ${pipeline.subjectVersion ?? "unavailable"} · Run ${pipeline.orchestrationRunId ?? "unavailable"} · Node ${pipeline.orchestrationNodeId ?? "unavailable"} · Fence ${pipeline.fencingToken ?? "unavailable"}`);
          fillList(byId("livework-omega-failures"), pipeline.omegaReadiness?.failures || [], (failure) => { const row = document.createElement("li"); text(row, failure); return row; }, pipeline.omegaReadiness ? "No readiness failures reported." : "Readiness not reported.");
          const byKey = new Map((pipeline.nodes || []).map((node) => [node.key, node]));
          LIVE_WORK_KEYS.forEach((key) => { const node = byKey.get(key); if (node) liveWorkNodeApply(key, node.status, node.detail); else liveWorkNodeApply(key, "unavailable", "Not reported."); });
          text(eventsStatus, `${pipeline.events.length} EVENT${pipeline.events.length === 1 ? "" : "S"}`);
          fillList(byId("livework-events"), pipeline.events.map((event) => ({ summary: event.summary, occurredAt: event.at, actor: "Development" })), activityEventRow, "No mission events recorded yet.");
          text(byId("nav-livework-count"), pipeline.missionInFlight ? 1 : 0);
        }
        function renderGeneral() {
          const settings = state.generalSettings;
          const banner = byId("timezone-banner");
          const note = byId("tz-machine-note");
          const timezone = settings && settings.timezone;
          if (!timezone) {
            banner.hidden = true;
            note.hidden = true;
            text(byId("tz-effective"), "Unavailable");
            text(byId("tz-source"), "Unavailable");
            return;
          }
          const sourceLabel = timezone.source === "env" ? "JARVIS_TIMEZONE (.env.local)" : "Machine default";
          text(byId("tz-source"), sourceLabel);
          if (!timezone.valid || !timezone.effectiveIana) {
            banner.hidden = false;
            text(byId("tz-effective"), "Invalid");
            const configured = timezone.envRaw ? `Configured (invalid): ${timezone.envRaw}. ` : "Configured value is invalid. ";
            text(note, `${configured}Machine would be ${timezone.machineIana}. That zone is not applied.`);
            note.hidden = false;
            return;
          }
          banner.hidden = true;
          note.hidden = true;
          text(byId("tz-effective"), timezone.effectiveIana);
        }
        function renderCredentials() {
          const root = byId("credentials-cards");
          if (!root) return;
          const credentials = state.credentials;
          const banner = byId("credentials-banner");
          const approvals = byId("credentials-approvals");
          const local = byId("credentials-local");
          const links = byId("credentials-links");
          root.replaceChildren();
          links.replaceChildren();
          if (!credentials) {
            banner.hidden = true;
            approvals.hidden = false;
            text(approvals, "Credentials status could not be reached.");
            text(local, "Generate and rotate on the loopback settings page. This console does not mint secrets.");
            text(byId("nav-settings-count"), 0);
            return;
          }
          banner.hidden = !credentials.banner;
          if (credentials.banner) text(banner, credentials.banner);
          approvals.hidden = !credentials.approvalsWarning;
          if (credentials.approvalsWarning) text(approvals, credentials.approvalsWarning);
          credentials.tokens.forEach((card) => {
            const section = document.createElement("section");
            section.className = "cred-card";
            const title = document.createElement("h3");
            text(title, card.label);
            const statusLine = document.createElement("p");
            statusLine.className = "settings-status";
            text(statusLine, card.statusLabel + " · " + card.overlapLabel);
            const fingerprint = document.createElement("span");
            fingerprint.className = "fp-chip";
            text(fingerprint, card.fingerprint || "—");
            section.append(title, statusLine, fingerprint);
            if (card.warning) {
              const warn = document.createElement("p");
              warn.className = card.equalsServiceToken ? "cred-bad" : "cred-warn";
              text(warn, card.warning);
              section.append(warn);
            }
            const danger = document.createElement("a");
            danger.href = "/settings/danger#" + card.id;
            danger.rel = "noreferrer";
            text(danger, "Open Danger zone");
            section.append(danger);
            root.append(section);
          });
          text(local, credentials.localPage
            ? "Generate and rotate on the local host page " + credentials.localPage + ". This console does not mint secrets or call Convex."
            : "Generate stays on the loopback host. This console does not mint secrets or call Convex.");
          const docs = credentials.docs || {};
          [["Open HTTP API docs", docs.httpApi], ["Open MCP preview runbook", docs.mcpPreview], ["Open exposure / remote gateway docs", docs.exposure], ["Open rotation runbook", docs.rotation]].forEach(([label, href]) => {
            if (!href) return;
            const item = document.createElement("li");
            const anchor = document.createElement("a");
            anchor.href = href;
            anchor.rel = "noreferrer";
            text(anchor, label);
            item.append(anchor);
            links.append(item);
          });
          text(byId("nav-settings-count"), credentials.failClosed ? "!" : credentials.tokens.filter((card) => card.configured).length);
        }
        let persistenceView = null;
        function openPersistenceDialog(id) { document.querySelectorAll("[data-persistence-dialog]").forEach((dialog) => { dialog.hidden = true; }); const dialog = byId(id); if (!dialog) return; dialog.hidden = false; const cancel = dialog.querySelector("[data-persistence-cancel]"); if (cancel) cancel.focus(); }
        function renderPersistence(settings) { persistenceView = settings; text(byId("persistence-honesty"), settings.honesty); const banner = byId("persistence-banner"); banner.hidden = !settings.provider.banner; text(banner, settings.provider.banner || ""); text(byId("persistence-provider-label"), settings.provider.active ? "Active provider: " + settings.provider.active : "Provider unset"); text(byId("persistence-convex"), settings.provider.convexDeployment ? "deployment " + settings.provider.convexDeployment : "deployment not configured"); text(byId("persistence-json"), "path " + settings.provider.jsonStatePath); text(byId("persistence-provider-chip"), settings.provider.active || "unset"); text(byId("persistence-health-chip"), settings.health.status); text(byId("persistence-glance"), settings.health.status); text(byId("persistence-export-warning"), settings.backup.exportWarning); text(byId("persistence-v4-label"), settings.backup.v4Label); const refusal = byId("persistence-v4-refusal"); refusal.hidden = !settings.backup.v4ExportRefusal; text(refusal, settings.backup.v4ExportRefusal || ""); byId("persistence-backup").disabled = !settings.actions.exportClassic; byId("persistence-restore-classic").disabled = !settings.actions.restoreClassic; byId("persistence-export-v4").disabled = !settings.actions.exportV4; const classicFile = byId("persistence-export-classic-file"); const v4File = byId("persistence-export-v4-file"); if (!classicFile.value) classicFile.value = settings.suggestedClassicPath; if (!v4File.value) v4File.value = settings.suggestedV4Path; }
        async function loadPersistence() { try { const result = await request("tools/call", { name: "show_persistence_settings", arguments: {} }, 10000); const data = structured(result); if (!data || !data.settings) throw new Error("missing"); renderPersistence(data.settings); } catch { text(byId("persistence-glance"), "Health unreachable"); } }
        async function runPersistence(action, fields, resultId) { try { const result = await request("tools/call", { name: "run_persistence_settings_action", arguments: Object.assign({ action }, fields) }, 10000); const data = structured(result); const outcome = data && data.result; if (!outcome) throw new Error("missing"); text(byId(resultId), outcome.detail); return outcome; } catch { text(byId(resultId), "Action failed."); return null; } }
        

        function todayItem(title, detail, extraClass) { const li = document.createElement("li"); if (extraClass) li.className = extraClass; const item = document.createElement("div"); item.className = "today-item"; const strong = document.createElement("b"); text(strong, title); item.appendChild(strong); if (detail) { const small = document.createElement("small"); text(small, detail); item.appendChild(small); } li.appendChild(item); return li; }
        function todayEmpty(list, message) { const li = document.createElement("li"); li.className = "today-empty"; text(li, message); list.appendChild(li); }
        function todayDue(reminder) { if (typeof reminder.dueAt === "number") { try { return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(reminder.dueAt)); } catch { /* fall through */ } } return reminder.dueRaw ? String(reminder.dueRaw) : "No time set"; }
        function plural(count, one, many) { return count + " " + (count === 1 ? one : many); }
        // BEGIN today-summary
        function todaySummaryText(taskCount, overdueCount, errandCount, loaded) {
          var parts = [];
          var count = function (n, one, many) { return n + " " + (n === 1 ? one : many); };
          if (taskCount > 0) parts.push(count(taskCount, "task", "tasks"));
          if (overdueCount > 0) parts.push(count(overdueCount, "overdue reminder", "overdue reminders"));
          if (errandCount > 0) parts.push(count(errandCount, "errand", "errands"));
          if (parts.length) return parts.join(" · ");
          return loaded ? "All clear. Nothing needs doing right now." : "Loading your day…";
        }
        // END today-summary
        function renderToday() {
          const tasksEl = byId("today-tasks"); if (!tasksEl) return;
          const now = Date.now();
          try { text(byId("today-date"), new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long" }).format(new Date(now))); } catch { text(byId("today-date"), "Today"); }
          const open = activeTasks();
          tasksEl.replaceChildren();
          if (!state.tasksLoaded) todayEmpty(tasksEl, "Loading…");
          else if (!open.length) todayEmpty(tasksEl, "Nothing on your list. Nice.");
          open.forEach((task) => { const li = todayItem(task.title, task.category && task.category !== "personal" ? task.category : ""); const done = document.createElement("button"); done.type = "button"; done.className = "today-done"; text(done, "Done"); done.setAttribute("aria-label", "Mark " + task.title + " done"); done.addEventListener("click", async () => { done.disabled = true; try { await callTool("complete_task", { taskId: task.id }); toast("Nice. " + task.title + " is done."); } catch { toast("Could not mark that done.", true); done.disabled = false; } }); li.appendChild(done); tasksEl.appendChild(li); });
          text(byId("today-task-count"), state.tasksLoaded ? plural(open.length, "open", "open") : "");
          const reminders = state.reminders.slice().sort((a, b) => (typeof a.dueAt === "number" ? a.dueAt : Infinity) - (typeof b.dueAt === "number" ? b.dueAt : Infinity));
          const remindersEl = byId("today-reminders"); remindersEl.replaceChildren();
          if (!state.remindersLoaded) todayEmpty(remindersEl, "Loading…");
          else if (!reminders.length) todayEmpty(remindersEl, "No reminders.");
          let overdue = 0;
          reminders.forEach((reminder) => { const late = typeof reminder.dueAt === "number" && reminder.dueAt < now; if (late) overdue += 1; remindersEl.appendChild(todayItem(reminder.title, (late ? "Overdue · " : "") + todayDue(reminder), late ? "today-overdue" : "")); });
          text(byId("today-reminder-count"), state.remindersLoaded ? plural(reminders.length, "reminder", "reminders") : "");
          const errandsEl = byId("today-errands"); errandsEl.replaceChildren();
          const errands = state.brief && state.brief.errands && Array.isArray(state.brief.errands.open) ? state.brief.errands.open : null;
          if (!errands) todayEmpty(errandsEl, "Loading…");
          else if (!errands.length) todayEmpty(errandsEl, "No errands to run.");
          else errands.forEach((errand) => { const li = todayItem(errand.title, errand.quantity ? "× " + errand.quantity : (errand.location && errand.location.label) || ""); const done = document.createElement("button"); done.type = "button"; done.className = "today-done"; text(done, "Done"); done.setAttribute("aria-label", "Tick off " + errand.title); done.addEventListener("click", async () => { done.disabled = true; try { await callTool("update_errand", { errandId: errand.id, status: "done" }); const brief = state.brief && state.brief.errands; if (brief && Array.isArray(brief.open)) { brief.open = brief.open.filter((item) => item.id !== errand.id); brief.openCount = Math.max(0, (brief.openCount || 1) - 1); } render(); toast("Ticked off " + errand.title + "."); callTool("show_jarvis_dashboard").catch(() => { /* the next poll catches up */ }); } catch { toast("Could not tick that off.", true); done.disabled = false; } }); li.appendChild(done); errandsEl.appendChild(li); });
          text(byId("today-errand-count"), errands ? plural(errands.length, "to run", "to run") : "");
          const waiting = state.approvals && state.approvals.status === "ready" ? Number(state.approvals.proposedCount) || 0 : 0;
          const approvals = byId("today-approvals");
          approvals.hidden = waiting === 0;
          text(approvals, waiting === 1 ? "1 thing is waiting for your approval" : waiting + " things are waiting for your approval");
          text(byId("today-summary"), todaySummaryText(open.length, overdue, errands ? errands.length : 0, state.tasksLoaded && state.remindersLoaded));
          const navCount = byId("nav-today-count"); if (navCount) text(navCount, open.length + overdue);
        }
        function render() { renderToday(); renderCounts(); renderFocus(); renderBoard(); renderReminders(); renderSystems(); renderCategories(); renderPriorities(); renderRightReminders(); renderOperations(); renderActivity(); renderInbox(); renderActivityTimeline(); renderLiveWork(); renderGeneral(); renderCredentials();  renderTeamBoard(); hudPanelRegistry.forEach((panel) => { if (typeof panel.render !== "function") return; try { panel.render(state); } catch { /* an extension panel stays fail-closed */ } }); }

        // BEGIN hud-team-board
        const BACKDROP_RANK = { STOPPED: 4, UNKNOWN: 3, WARN: 2, OK: 1, "NO LIMIT": 0 };
        function rankBackdrop(readings) {
          if (!readings.length) return "UNKNOWN";
          let best = readings[0];
          readings.forEach((reading) => {
            if ((BACKDROP_RANK[reading] || 0) > (BACKDROP_RANK[best] || 0)) best = reading;
          });
          return best;
        }
        function deriveBackdropSeverity(snapshot) {
          if (!snapshot || !snapshot.status) return "UNKNOWN";
          const readings = [];
          const status = snapshot.status;
          if (status.status === "unavailable" || status.zState === "suspended" || (status.securityHalt && status.securityHalt.dispatch === "refused")) readings.push("STOPPED");
          else if (status.status === "degraded") readings.push("WARN");
          else if (status.status === "ok") readings.push("OK");
          else readings.push("UNKNOWN");
          const limits = snapshot.limitsState;
          if (limits === "STOPPED" || limits === "WARN" || limits === "OK") readings.push(limits);
          const inbox = snapshot.inbox;
          if (inbox && Array.isArray(inbox.items)) {
            if (inbox.items.some((item) => item && item.severity === "critical")) readings.push("STOPPED");
            else if (inbox.items.some((item) => item && (item.severity === "high" || item.severity === "elevated"))) readings.push("WARN");
          }
          const live = snapshot.liveWork;
          if (live && live.status === "ready" && live.pipeline && (live.pipeline.state === "REPAIR_REQUIRED" || live.pipeline.state === "INDETERMINATE")) readings.push("WARN");
          if (!readings.length) return "UNKNOWN";
          return rankBackdrop(readings);
        }
        function deriveHudPresence(input) {
          const status = input && input.status;
          if (!status) return "connecting";
          if (status.status === "unavailable") return "offline";
          if (status.zState === "suspended") return "blocked";
          if (status.securityHalt && status.securityHalt.dispatch === "refused") return "blocked";
          const reconciliation = status.reconciliation || {};
          if (reconciliation.state === "degraded" || reconciliation.lastCycleOutcome === "failed") return "reconciling";
          if (status.status === "degraded") return "degraded";
          if ((input.proposedApprovalCount || 0) > 0) return "waiting_for_approval";
          if (!status.layers || typeof status.layers !== "object") return "degraded";
          const layers = Object.values(status.layers);
          if (layers.some((layer) => layer && layer.status === "blocked")) return "blocked";
          if (layers.some((layer) => !layer || layer.status !== "ready")) return "degraded";
          return "idle";
        }
        function hudPresenceInput() {
          const approvals = state.approvals;
          if (approvals && approvals.status === "ready") {
            return { status: state.status, proposedApprovalCount: approvals.proposedCount };
          }
          return { status: state.status };
        }
        function limitsChipState() {
          const chip = byId("limits-now-chip");
          const label = chip && chip.textContent ? chip.textContent : "";
          const match = label.match(/STOPPED|UNKNOWN|WARN|OK|NO LIMIT/);
          return match ? match[0] : "UNKNOWN";
        }
        function renderApprovalsHonesty() {
          const stage = byId("approvals-stage");
          const source = byId("approvals-source");
          if (!stage || !source) return;
          const approvals = state.approvals;
          if (approvals && approvals.status === "ready") {
            const count = approvals.proposedCount + (approvals.capped ? "+" : "");
            text(stage, approvals.proposedCount > 0 ? count + " PROPOSED" : "NONE PROPOSED");
            text(source, approvals.proposedCount > 0
              ? count + " governed tool-action proposal(s) await approval. This console does not approve, reject, or execute."
              : "No governed tool-action proposals await approval. This console does not approve, reject, or execute.");
            return;
          }
          const inbox = state.inbox;
          if (!inbox || !Array.isArray(inbox.sources)) {
            text(stage, "UNKNOWN");
            text(source, "Tool-action proposals are not on this snapshot. This console does not approve, reject, or execute.");
            return;
          }
          const toolActions = inbox.sources.find((item) => item && item.source === "toolActions");
          if (!toolActions) {
            text(stage, "UNKNOWN");
            text(source, "The operations inbox did not report a toolActions source.");
            return;
          }
          text(stage, String(toolActions.status || "UNKNOWN").toUpperCase());
          text(source, toolActions.reason || "No proposal list is attached to the dashboard snapshot. This console does not approve, reject, or execute.");
        }
        function renderTeamBoard() {
          text(byId("crew-status"), "UNKNOWN");
          text(byId("chip-crew"), "Crew · UNKNOWN");
          text(byId("crew-detail"), "No crew roster is on this NOLAN. Names are not invented.");
          if (!state.tasksLoaded) text(byId("chip-load"), "Load · UNKNOWN");
          else text(byId("chip-load"), "Load · " + state.counts.activeTasks);
          if (!state.remindersLoaded) text(byId("chip-next"), "Next · UNKNOWN");
          else {
            const upcoming = state.reminders.slice().sort((a, b) => reminderDue(a) - reminderDue(b));
            const next = upcoming[0];
            text(byId("chip-next"), next ? "Next · " + reminderTime(next) : "Next · NONE");
          }
          const presence = deriveHudPresence(hudPresenceInput());
          text(byId("chip-presence"), "Presence · " + presence.toUpperCase());
          const presenceEl = byId("hud-presence");
          if (presenceEl) text(presenceEl, presence.toUpperCase());
          renderApprovalsHonesty();
          const severity = deriveBackdropSeverity({
            status: state.status,
            inbox: state.inbox,
            liveWork: state.liveWork,
            limitsState: limitsChipState(),
          });
          document.body.dataset.backdropSeverity = severity;
          const queued = Math.max(0, activeTasks().length - 1);
          const shown = Math.min(3, queued);
          const caption = byId("next-caption");
          if (caption) text(caption, "Showing " + shown + " of " + queued);
          renderConsole();
        }
        function renderConsole() {
          const status = state.status;
          const layers = layerEntries();
          const ready = layers.filter(([, value]) => value.status === "ready").length;
          text(byId("ring-layers"), status ? ready + "/" + (layers.length || 8) : "UNKNOWN");
          const arc = byId("ring-layers-arc");
          if (arc) {
            const pct = status && layers.length ? Math.round((ready / layers.length) * 100) : 0;
            arc.setAttribute("stroke-dasharray", pct + " " + (100 - pct));
          }
          const persistence = status && status.provider ? String(status.provider.reachability || "UNKNOWN").toUpperCase() : "UNKNOWN";
          text(byId("ring-persistence"), persistence);
          const zState = status && status.zState ? String(status.zState).toUpperCase() : "UNKNOWN";
          text(byId("ring-z"), zState);
          text(byId("totality-state-value"), status && status.status ? String(status.status).toUpperCase() : "UNKNOWN");
          text(byId("core-side-status"), status && status.status ? String(status.status).toUpperCase() : "UNKNOWN");
          const predictor = byId("predictor-state");
          const line = byId("predictor-line");
          if (!state.tasksLoaded) {
            text(predictor, "UNKNOWN");
            if (line) line.setAttribute("points", "");
          } else {
            const counts = {};
            state.tasks.forEach((task) => {
              const key = task.category || "personal";
              counts[key] = (counts[key] || 0) + 1;
            });
            const entries = Object.entries(counts);
            text(predictor, entries.length ? entries.map(([key, value]) => key + " " + value).join(" · ") : "No tasks recorded.");
            if (line) {
              if (!entries.length) line.setAttribute("points", "16,100 284,100");
              else {
                const max = Math.max(1, ...entries.map(([, value]) => value));
                line.setAttribute("points", entries.map(([, value], index) => {
                  const x = entries.length === 1 ? 150 : 16 + (index * 268) / (entries.length - 1);
                  const y = 100 - (value / max) * 72;
                  return x + "," + y;
                }).join(" "));
              }
            }
          }
          text(byId("waveform-state"), "No waveform signal.");
          ["host", "mem", "store", "link"].forEach((name) => text(byId("dial-" + name), "UNKNOWN"));
          const list = byId("data-list");
          if (list) {
            list.replaceChildren();
            const integrations = status && Array.isArray(status.integrations) ? status.integrations : null;
            if (!status || !integrations) list.append(empty("UNKNOWN"));
            else if (!integrations.length) list.append(empty("No integrations recorded."));
            else integrations.forEach((item) => {
              const row = document.createElement("div");
              row.className = "data-row";
              const name = document.createElement("span");
              const stage = document.createElement("b");
              const bar = document.createElement("i");
              text(name, item.name || "integration");
              const stageWord = String(item.stage || "UNKNOWN");
              text(stage, stageWord.toUpperCase());
              const width = stageWord === "production-approved" || stageWord === "commissioned" ? "100%" : stageWord === "configured" ? "55%" : stageWord === "implemented" ? "30%" : "8%";
              bar.style.width = width;
              row.append(name, bar, stage);
              list.append(row);
            });
          }
          text(byId("tile-tasks"), state.tasksLoaded ? String(state.counts.activeTasks) : "UNKNOWN");
          text(byId("tile-reminders"), state.remindersLoaded ? String(state.counts.reminders) : "UNKNOWN");
          const inbox = state.inbox;
          text(byId("tile-inbox"), inbox && Array.isArray(inbox.items) ? String(inbox.items.length) : "UNKNOWN");
          text(byId("network-version"), status && status.version ? String(status.version) : "UNKNOWN");
          text(byId("dev-status"), "DEVELOPMENT · NOT AUTHORISED");
          const map = byId("tactical-map");
          if (map) {
            map.replaceChildren();
            const caption = byId("tactical-caption");
            if (!inbox) {
              if (caption) text(caption, "UNKNOWN");
            } else if (!Array.isArray(inbox.items) || !inbox.items.length) {
              if (caption) text(caption, "NO SIGNAL");
            } else {
              if (caption) text(caption, "");
              inbox.items.slice(0, 6).forEach((item) => {
                const node = document.createElement("span");
                node.className = "tac-node";
                text(node, item.title || "Untitled");
                map.append(node);
              });
            }
          }
          text(byId("analyzer-persistence"), persistence);
          text(byId("analyzer-z"), zState);
          text(byId("analyzer-limits"), limitsChipState());
          text(byId("analyzer-presence"), deriveHudPresence(hudPresenceInput()).toUpperCase());
          const live = state.liveWork;
          let liveWord = "UNKNOWN";
          if (live && live.status === "unavailable") liveWord = "UNAVAILABLE";
          else if (live && live.pipeline && live.pipeline.state) liveWord = String(live.pipeline.state);
          else if (live && live.status === "ready") liveWord = "NONE";
          text(byId("analyzer-live"), liveWord);
          const bar = byId("totality-bar");
          if (bar) {
            if (!status || !layers.length) {
              bar.style.width = "100%";
              bar.style.height = "0%";
              text(byId("totality-bar-label"), "UNKNOWN");
            } else {
              const pct = Math.round((ready / layers.length) * 100);
              bar.style.width = "100%";
              bar.style.height = pct + "%";
              text(byId("totality-bar-label"), ready + "/" + layers.length + " layers ready");
            }
          }
          text(byId("gauge-load"), "UNKNOWN");
          text(byId("gauge-efficiency"), "UNKNOWN");
        }
        // BEGIN voice-console (#567)
        function normalizeVoicePhrase(raw) {
          return String(raw == null ? "" : raw)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/^[\s.,!?;:]+/, "")
            .replace(/[\s.,!?;:]+$/, "");
        }
        // Like normalizeVoicePhrase but keeps the speaker's casing, so a dictated
        // title reaches the server as "call Dave", not "call dave". Matching on the
        // server is still case-insensitive. Null when the two forms cannot align.
        function voicePhrasePreservingCase(raw) {
          var cased = String(raw == null ? "" : raw)
            .trim()
            .replace(/\s+/g, " ")
            .replace(/^[\s.,!?;:]+/, "")
            .replace(/[\s.,!?;:]+$/, "");
          return cased.toLowerCase() === normalizeVoicePhrase(raw) ? cased : null;
        }
        function voiceCapabilities(view) {
          var w = view || (typeof window !== "undefined" ? window : {});
          return {
            recognition: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
            synthesis: !!w.speechSynthesis,
          };
        }
        // NOLAN is the public wake word; legacy "Jarvis" stays accepted, matching the server splitter.
        var VOICE_WAKE_WORDS = ["nolan", "jarvis"];
        function voiceWakeGate(raw, isFinal, wakeWord) {
          var words = (Array.isArray(wakeWord) ? wakeWord : wakeWord ? [wakeWord] : VOICE_WAKE_WORDS)
            .map(normalizeVoicePhrase);
          var text = normalizeVoicePhrase(raw);
          var cased = voicePhrasePreservingCase(raw);
          for (var i = 0; i < words.length; i += 1) {
            var word = words[i];
            if (!word) continue;
            if (text === word) return { status: "awake" };
            if (text.indexOf(word) !== 0) continue;
            var after = text.slice(word.length);
            var separator = /^[\s.,!?;:]+/.exec(after);
            if (!separator) continue;
            var rest = after.slice(separator[0].length).trim();
            if (!rest) return { status: "awake" };
            var casedRest = cased === null ? null : cased.slice(word.length + separator[0].length).trim();
            if (casedRest === null || casedRest.toLowerCase() !== rest) casedRest = rest;
            return { status: "command", transcript: casedRest, isFinal: !!isFinal };
          }
          return { status: "idle" };
        }
        function prepareVoiceDispatch(raw, isFinal, alternatives, wakeWord) {
          if (!isFinal) return null;
          var gate = voiceWakeGate(raw, true, wakeWord);
          if (gate.status !== "command") return null;
          var preparedAlternatives = [];
          (alternatives || []).forEach(function (alternative) {
            var alternativeGate = voiceWakeGate(alternative, true, wakeWord);
            var prepared = alternativeGate.status === "command"
              ? alternativeGate.transcript
              : (voicePhrasePreservingCase(alternative) || normalizeVoicePhrase(alternative));
            if (prepared && preparedAlternatives.indexOf(prepared) < 0) preparedAlternatives.push(prepared);
          });
          return {
            transcript: gate.transcript,
            isFinal: true,
            alternatives: preparedAlternatives,
            heardTranscript: voicePhrasePreservingCase(raw) || normalizeVoicePhrase(raw),
          };
        }
        function finalVoiceRecognition(event) {
          if (!event || !event.results) return null;
          var segments = [];
          var start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
          for (var i = start; i < event.results.length; i += 1) {
            var result = event.results[i];
            if (!result || !result.isFinal || !result.length || !result[0]) continue;
            var segment = { top: String(result[0].transcript || ""), alternatives: [] };
            for (var j = 1; j < result.length; j += 1) {
              if (result[j]) segment.alternatives.push(String(result[j].transcript || ""));
            }
            segments.push(segment);
          }
          if (!segments.length) return null;
          var transcript = segments.map(function (segment) { return segment.top; }).join("").trim();
          var alternatives = [];
          segments.forEach(function (segment, segmentIndex) {
            segment.alternatives.forEach(function (alternative) {
              if (alternatives.length >= 16) return;
              var combined = segments
                .map(function (item, index) { return index === segmentIndex ? alternative : item.top; })
                .join("")
                .trim();
              if (combined && combined !== transcript && alternatives.indexOf(combined) < 0) alternatives.push(combined);
            });
          });
          return { transcript: transcript, alternatives: alternatives };
        }
        // Presentation only: the prompt names the command ids the server returned, in
        // the server's order. It holds no choice, sends nothing and grants nothing —
        // the reply is an ordinary utterance that the server session resolves.
        function describeVoiceClarification(candidates, catalog, profile) {
          var generic = { label: "Sorry, I wasn't sure what you meant, so I didn't do anything.", tone: "warn" };
          var MAX_CANDIDATES = 64, MAX_CHOICES = 4, MAX_SUMMARY = 80;
          if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_CANDIDATES) return generic;
          var commands = Array.isArray(catalog) ? catalog : [];
          var seen = [];
          var labels = [];
          var allKnown = true;
          for (var i = 0; i < candidates.length; i += 1) {
            var id = candidates[i];
            // A list that is not plain, distinct ids cannot be numbered truthfully.
            if (typeof id !== "string" || id.length > 64 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || seen.indexOf(id) >= 0) return generic;
            seen.push(id);
            var summary = "";
            for (var j = 0; j < commands.length && !summary; j += 1) {
              var command = commands[j];
              if (command && command.id === id && command.profile === profile && typeof command.summary === "string") {
                summary = command.summary.replace(/\s+/g, " ").trim().replace(/[.!?;:]+$/, "");
              }
            }
            if (!summary) allKnown = false;
            else if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1).trim() + "…";
            if (i < MAX_CHOICES) labels.push(summary || id);
          }
          var more = candidates.length > MAX_CHOICES ? "; and " + (candidates.length - MAX_CHOICES) + " more" : "";
          if (!allKnown) {
            return {
              label: "Sorry, I wasn't sure which you meant, so I didn't do anything. Can you say it again?",
              tone: "warn",
            };
          }
          var choices = labels.length === 1
            ? labels[0]
            : labels.map(function (label, index) { return (index + 1) + ". " + label; }).join("; ");
          return {
            label: "Did you mean " + choices + more +
              "? Say “Nolan” and your choice. I haven't done anything yet.",
            tone: "warn",
          };
        }
        function voiceCaptureDue(capture) {
          if (!capture || typeof capture.dueRaw !== "string" || !capture.dueRaw) return "";
          if (typeof capture.dueAt === "number" && typeof capture.dueTimezone === "string") {
            try {
              return " due " + new Intl.DateTimeFormat("en-AU", { timeZone: capture.dueTimezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(capture.dueAt));
            } catch (error) {
              return " due “" + capture.dueRaw + "”";
            }
          }
          return " due “" + capture.dueRaw + "” (no time set" + (/\d/.test(capture.dueRaw) ? " — say am or pm" : "") + ")";
        }
        function voiceCaptureWhat(command, capture) {
          var tool = command && command.proposes ? command.proposes.tool : "";
          var operation = command && command.proposes ? command.proposes.operation : "";
          if (operation === "complete") {
            var item = (tool === "tasks" ? "task" : "errand") + " “" + capture.title + "”";
            return { ask: "Mark " + item + " done", staged: "completing " + item, pending: "mark " + item + " done", effect: "changes" };
          }
          if (tool === "reminders" && operation === "reschedule") {
            var moved = "reminder “" + capture.title + "”";
            return { ask: "Reschedule " + moved + voiceCaptureDue(capture), staged: "rescheduling " + moved + voiceCaptureDue(capture), pending: "reschedule " + moved, effect: "changes" };
          }
          if (tool === "errands" && operation === "remove") {
            var removal = "errand “" + capture.title + "”";
            return { ask: "Remove " + removal + " from the list", staged: "removing " + removal, pending: "remove " + removal, effect: "changes" };
          }
          if (tool === "reminders" && operation === "cancel") {
            var reminder = "reminder “" + capture.title + "”";
            return { ask: "Cancel " + reminder, staged: "cancelling " + reminder, pending: "cancel " + reminder, effect: "changes" };
          }
          var what;
          if (tool === "tasks") what = "task “" + capture.title + "”" + (capture.category ? " (" + capture.category + ")" : "");
          else if (tool === "errands") what = "errand “" + capture.title + "”";
          else what = "reminder “" + capture.title + "”" + voiceCaptureDue(capture);
          return { ask: "Add " + what, staged: what, pending: "add " + what, effect: "is created" };
        }
        function voiceSpokenDue(capture) {
          if (!capture || typeof capture.dueAt !== "number" || typeof capture.dueTimezone !== "string") return "";
          try {
            return " " + new Intl.DateTimeFormat("en-AU", { timeZone: capture.dueTimezone, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(capture.dueAt)).replace(",", " at");
          } catch (error) {
            return "";
          }
        }
        // Owner-approved direct writes (#voice-direct): short, human replies with no read-back.
        function describeVoiceDirect(dispatch, capture) {
          var proposes = dispatch.command && dispatch.command.proposes ? dispatch.command.proposes : {};
          var key = proposes.tool + ":" + proposes.operation;
          var title = capture.title;
          if (dispatch.decision === "undone") {
            var reopened = key === "tasks:complete" || key === "errands:complete";
            var undone = reopened ? "Okay, " + title + " is back on the list." : "Okay, I've taken " + title + " off.";
            return { label: undone, tone: "muted" };
          }
          var spoken;
          if (key === "tasks:create") spoken = "Done. " + title + " is on your list.";
          else if (key === "reminders:create") spoken = "Okay, I'll remind you: " + title + voiceSpokenDue(capture) + ".";
          else if (key === "errands:create") spoken = "Got it. " + title + " is on your errands.";
          else if (key === "tasks:complete") spoken = "Nice. " + title + " is done.";
          else if (key === "errands:complete") spoken = "Ticked off " + title + ".";
          else spoken = "Done.";
          var undoHint = typeof dispatch.undoExpiresAt === "number" && dispatch.undoExpiresAt > 0 ? " Say “Nolan undo” to reverse it." : "";
          return { label: spoken + undoHint, speech: spoken, tone: "ok" };
        }
        function describeVoiceDispatch(dispatch, catalog, profile) {
          if (dispatch && dispatch.decision === "undo-unavailable") {
            var why = typeof dispatch.reason === "string" && dispatch.reason.trim() ? dispatch.reason.trim() : "There's nothing to undo.";
            return { label: why, tone: "muted" };
          }
          if (dispatch && dispatch.decision === "ambiguous") {
            return describeVoiceClarification(dispatch.candidates, catalog, profile);
          }
          var capture = dispatch && dispatch.capture && typeof dispatch.capture.title === "string" ? dispatch.capture : null;
          if (capture && (dispatch.decision === "saved" || dispatch.decision === "undone")) {
            return describeVoiceDirect(dispatch, capture);
          }
          if (capture) {
            var what = voiceCaptureWhat(dispatch.command, capture);
            if (dispatch.decision === "awaiting-confirmation") {
              return { label: what.ask + "? Say “Nolan confirm” or “Nolan cancel”.", speech: what.ask + "? Say confirm or cancel.", tone: "pending" };
            }
            if (dispatch.decision === "proposed" && typeof dispatch.toolActionId === "string" && dispatch.toolActionId) {
              return { label: "Okay. I've asked for your approval to " + what.pending + ". Nothing " + what.effect + " until you approve it.", speech: "Okay. That's waiting for your approval.", tone: "ok" };
            }
          }
          if (dispatch && dispatch.decision === "completion-unresolved") {
            var unresolved = typeof dispatch.reason === "string" ? dispatch.reason.trim() : "";
            var unresolvedId = dispatch.command ? dispatch.command.id : "";
            var nothing = unresolvedId === "client.cancel-reminder" ? "Nothing cancelled." : unresolvedId === "client.remove-errand" ? "Nothing removed." : unresolvedId === "client.reschedule-reminder" ? "Nothing rescheduled." : "Nothing marked done.";
            return { label: unresolved ? nothing + " " + unresolved : nothing, tone: "warn" };
          }
          if (dispatch && dispatch.decision === "answered") {
            var answer = typeof dispatch.answer === "string" ? dispatch.answer.trim() : "";
            return answer
              ? { label: answer, tone: "ok" }
              : { label: "Sorry, I couldn't get an answer for that just now.", tone: "warn" };
          }
          if (dispatch && dispatch.decision === "conversation") {
            var reply = typeof dispatch.reply === "string" ? dispatch.reply : "";
            return reply.trim()
              ? { label: reply, tone: "ok" }
              : { label: "Sorry, I couldn't answer that just now.", tone: "warn", notice: true };
          }
          if (dispatch && dispatch.decision === "conversation-unavailable") {
            var notices = {
              "provider-error": "Sorry, I couldn't think that through just now. Try again?",
              refused: "Sorry, I can't help with that one.",
              "rate-limited": "I've hit my limit for a bit. Try again a little later.",
              "too-long": "That's a bit long for me. Can you say it shorter?",
              "reply-too-long": "That answer's too long to read out. Try asking for a bit less.",
              unavailable: "Sorry, I can't check that right now.",
              timeout: "Sorry, that took too long. Try again?",
              "tool-limit": "That's a few questions at once. Try one at a time.",
              ungrounded: "Sorry, I didn't quite get that. Can you say it another way?",
            };
            return { label: notices[dispatch.conversationReason] || "Sorry, I couldn't answer that just now.", tone: "warn", notice: true };
          }
          var map = {
            "ignored-interim": { label: "Listening…", tone: "muted" },
            empty: { label: "I didn't hear anything.", tone: "muted" },
            unrecognized: { label: "Sorry, I didn't catch that.", tone: "warn" },
            "query-unavailable": { label: "Sorry, I can't check that right now.", tone: "warn" },
            "awaiting-confirmation": { label: "Shall I go ahead? Say “Nolan confirm” or “Nolan cancel”.", speech: "Shall I go ahead? Say confirm or cancel.", tone: "pending" },
            "confirmation-not-pending": { label: "There's nothing waiting to confirm.", tone: "muted" },
            "confirmation-expired": { label: "That took too long, so I dropped it. Say it again?", tone: "warn" },
            cancelled: { label: "Okay, cancelled.", tone: "muted" },
            proposed: { label: "Okay. That's waiting for your approval.", tone: "ok" },
            "actuation-unavailable": { label: "I can't reach that device right now, so I didn't do anything.", tone: "warn" },
            actuated: { label: "Done.", tone: "ok" },
            "actuation-failed": { label: "That didn't work, so nothing changed.", tone: "warn" },
          };
          if (dispatch && dispatch.decision === "query-unavailable") {
            var reason = typeof dispatch.reason === "string" ? dispatch.reason.trim() : "";
            if (reason && !/no read-only query provider is connected/i.test(reason)) {
              return { label: reason, tone: "warn" };
            }
          }
          if (dispatch && dispatch.decision === "proposed") {
            var proposedReason = typeof dispatch.reason === "string" ? dispatch.reason.trim() : "";
            if (proposedReason) return { label: proposedReason, tone: "warn" };
          }
          if (dispatch && dispatch.decision === "awaiting-confirmation" && dispatch.command && typeof dispatch.command.summary === "string" && dispatch.command.summary.trim()) {
            var askWhat = dispatch.command.summary.trim().replace(/[.!?]+$/, "");
            askWhat = askWhat.charAt(0).toLowerCase() + askWhat.slice(1);
            return { label: "Do you want me to " + askWhat + "? Say “Nolan confirm” or “Nolan cancel”.", speech: "Do you want me to " + askWhat + "? Say confirm or cancel.", tone: "pending" };
          }
          return map[dispatch && dispatch.decision] || { label: "Hmm, something odd happened there.", tone: "muted" };
        }
        function voiceLatencyMs(startedAt, endedAt) {
          var start = Number(startedAt);
          var end = Number(endedAt);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
          return Math.round((end - start) * 10) / 10;
        }
        function voiceClock() {
          return typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        }
        function setupVoiceConsole() {
          var root = document.getElementById("voice-profiles");
          if (!root) return;
          var VOICE_PROFILES = ["crawler", "workshop", "trailer", "client"];
          // How long a profile switch waits for the command queued before it.
          // A request that never answers must not leave the profile paused.
          var PROFILE_SWITCH_WAIT_MS = 10000;
          var WAKE_WORDS = VOICE_WAKE_WORDS;
          // Browser errors after which the microphone must not resume on its own, each with
          // the notice shown. "aborted" covers the operator cancelling input in browser UI.
          var RECOGNITION_STOP_NOTICES = {
            "not-allowed": "the browser refused microphone access. Check the browser's microphone permission",
            "service-not-allowed": "the browser refused the speech recognition service. Check the browser's microphone permission",
            "audio-capture": "no microphone audio could be captured. Check the microphone and its input level",
            "language-not-supported": "the browser does not support speech recognition in en-AU",
            "aborted": "speech input was cancelled in the browser",
          };
          // Only a natural end (no error), no-speech and network are recoverable. Every other
          // code, known or not, stops safely.
          var RECOGNITION_RECOVERABLE_ERRORS = ["", "no-speech", "network"];
          // A session that ends this soon after starting, this many times in a row, is not retried.
          var RECOGNITION_SHORT_END_MS = 2000;
          var RECOGNITION_SHORT_END_LIMIT = 3;
          var caps = voiceCapabilities(typeof window !== "undefined" ? window : {});
          var state = {
            profile: "client", sessionId: null, sessionPromise: null, generation: 0,
            profilePending: false, profileFailed: false, commandQueue: Promise.resolve(),
            recognition: null, recognitionGeneration: 0, recognitionShortEnds: 0, catalog: [],
          };
          var capEl = document.getElementById("voice-capability");
          if (capEl) capEl.textContent = caps.recognition ? "MIC AVAILABLE" : "TYPED ONLY";
          var enableBtn = document.getElementById("voice-enable");
          var stopBtn = document.getElementById("voice-stop");
          if (enableBtn && !caps.recognition) {
            enableBtn.disabled = true;
            enableBtn.textContent = "Microphone unavailable";
          }

          function api(path, options) {
            return fetch(
              "/api/v1/voice" + path,
              Object.assign({ headers: { "content-type": "application/json", accept: "application/json" } }, options || {}),
            );
          }
          var speechGeneration = 0;
          var speechInFlight = false;
          function speechStatus(message) {
            var el = document.getElementById("voice-output-status");
            if (!el) return;
            el.textContent = message;
            // On a phone only a problem with the spoken reply is worth the space.
            if (el.dataset) el.dataset.tone = /fail|cannot|unavailable|not supported/i.test(message) ? "warn" : "info";
          }
          // Prefer a natural-sounding English voice (Australian first) over the browser default.
          function pickSpeechVoice(voices) {
            if (!voices || !voices.length) return null;
            var best = null;
            var bestScore = -1;
            for (var i = 0; i < voices.length; i++) {
              var voice = voices[i];
              var lang = String(voice.lang || "").toLowerCase();
              if (lang.indexOf("en") !== 0) continue;
              var name = String(voice.name || "");
              var score = 0;
              if (lang === "en-au") score += 4; else if (lang === "en-gb") score += 3; else if (lang === "en-us") score += 2; else score += 1;
              if (/(natural|neural|premium|enhanced|siri)/i.test(name)) score += 6;
              else if (/google/i.test(name)) score += 3;
              if (voice.localService === false) score += 1;
              if (score > bestScore) { best = voice; bestScore = score; }
            }
            return best;
          }
          function speak(label) {
            var generation = ++speechGeneration;
            speechInFlight = false;
            if (!caps.synthesis || typeof window.SpeechSynthesisUtterance !== "function") {
              speechStatus("Spoken output unavailable in this browser. Text remains available.");
              return;
            }
            try {
              window.speechSynthesis.cancel();
              var utterance = new window.SpeechSynthesisUtterance(label);
              var preferred = pickSpeechVoice(typeof window.speechSynthesis.getVoices === "function" ? window.speechSynthesis.getVoices() : null);
              if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
              utterance.rate = 1.05;
              utterance.onstart = function () {
                if (generation === speechGeneration) speechStatus("Browser speech started; audibility cannot be confirmed.");
              };
              utterance.onend = function () {
                if (generation === speechGeneration) { speechInFlight = false; speechStatus("Browser speech ended; cannot confirm it was heard."); }
              };
              utterance.onerror = function () {
                if (generation === speechGeneration) { speechInFlight = false; speechStatus("Browser speech failed. Text remains available."); }
              };
              var voices = typeof window.speechSynthesis.getVoices === "function" ? window.speechSynthesis.getVoices() : null;
              speechStatus(voices && !voices.length
                ? "No voices currently listed; requesting speech. Check your browser audio."
                : "Speech requested; waiting for the browser.");
              speechInFlight = true;
              window.speechSynthesis.speak(utterance);
            } catch (error) {
              if (generation === speechGeneration) { speechInFlight = false; speechStatus("Browser speech failed. Text remains available."); }
            }
          }
          var testOutputBtn = document.getElementById("voice-test-output");
          if (testOutputBtn) testOutputBtn.addEventListener("click", function () { speak("Speech output test."); });
          function renderPending(pending) {
            var el = document.getElementById("voice-pending");
            if (!el) return;
            if (pending && pending.command) {
              el.hidden = false;
              var pendingCapture = pending.capture && typeof pending.capture.title === "string" ? pending.capture : null;
              var pendingWhat = pendingCapture
                ? voiceCaptureWhat(pending.command, pendingCapture).pending
                : pending.command.summary;
              el.textContent = "Awaiting confirm: " + pendingWhat + " — say “Nolan confirm” or “Nolan cancel”.";
            } else {
              el.hidden = true;
              el.textContent = "";
            }
          }
          function renderResult(dispatch) {
            var info = describeVoiceDispatch(dispatch, state.catalog, state.profile);
            var el = document.getElementById("voice-result");
            if (el) {
              el.textContent = info.label;
              el.setAttribute("data-tone", info.tone);
            }
            if (!info.notice) speak(info.speech || info.label);
          }
          function renderLatency(startedAt, endedAt, failed) {
            var elapsed = voiceLatencyMs(startedAt, endedAt);
            var el = document.getElementById("voice-latency");
            if (!el || elapsed === null) return;
            el.textContent = failed
              ? "Dispatch failed after " + elapsed.toFixed(1) + " ms."
              : "Dispatch round-trip: " + elapsed.toFixed(1) + " ms.";
          }
          function readResponse(response) {
            if (!response.ok) {
              var error = new Error("Voice request failed.");
              error.status = response.status;
              throw error;
            }
            return response.json();
          }
          function renderNotice(message) {
            var el = document.getElementById("voice-result");
            if (el) { el.textContent = message; el.setAttribute("data-tone", "warn"); }
          }
          function retireSession(id) {
            if (id) api("/sessions/" + encodeURIComponent(id), { method: "DELETE" })
              .catch(function () { /* locally detached even if server cleanup is unavailable */ });
          }
          function invalidateSession() {
            var id = state.sessionId;
            state.generation += 1;
            state.sessionId = null;
            state.sessionPromise = null;
            state.commandQueue = Promise.resolve();
            renderPending(null);
            return id;
          }
          function acknowledgedSession(data, profile) {
            if (!data || typeof data.sessionId !== "string" || !data.sessionId || data.profile !== profile) {
              if (data && typeof data.sessionId === "string") retireSession(data.sessionId);
              throw new Error("Voice session profile was not acknowledged.");
            }
            return data.sessionId;
          }
          function ensureSession(generation) {
            if (generation !== state.generation) return Promise.resolve(null);
            if (state.sessionId) return Promise.resolve(state.sessionId);
            if (state.sessionPromise) return state.sessionPromise;
            var profile = state.profile;
            var creation = api("/sessions", { method: "POST", body: JSON.stringify({ profile: profile }) })
              .then(readResponse)
              .then(function (data) {
                var id = acknowledgedSession(data, profile);
                if (generation !== state.generation) { retireSession(id); return null; }
                state.sessionId = id;
                return id;
              })
              .finally(function () {
                if (state.sessionPromise === creation) state.sessionPromise = null;
              });
            state.sessionPromise = creation;
            return creation;
          }
          function dispatch(transcript, isFinal, alternatives, heardTranscript) {
            if (state.profilePending || state.profileFailed) {
              renderNotice(state.profilePending
                ? "Changing voice profile. Commands are paused; submit a fresh command once ready."
                : "Voice profile change failed. Select a profile to retry before sending commands.");
              return Promise.resolve();
            }
            var generation = state.generation;
            // Keep one ordered command stream. Invalidated queued commands are never replayed.
            var command = state.commandQueue.then(function () {
              if (generation !== state.generation) return;
              var startedAt = voiceClock();
              return ensureSession(generation)
                .then(function (id) {
                  if (!id || generation !== state.generation) return null;
                  var utterance = { transcript: transcript, isFinal: isFinal, alternatives: alternatives || [] };
                  if (heardTranscript) utterance.heardTranscript = heardTranscript;
                  return api("/sessions/" + encodeURIComponent(id) + "/utterances", {
                    method: "POST",
                    body: JSON.stringify(utterance),
                  }).then(readResponse);
                })
                .then(function (payload) {
                  if (!payload || generation !== state.generation) return;
                  renderLatency(startedAt, voiceClock(), false);
                  renderResult(payload.dispatch);
                  renderPending(payload.pending);
                  var written = payload.dispatch && (payload.dispatch.decision === "saved" || payload.dispatch.decision === "undone");
                  if (written && typeof callTool === "function") callTool("show_jarvis_dashboard").catch(function () { /* the next poll catches up */ });
                })
                .catch(function (error) {
                  if (generation !== state.generation) return;
                  var id = invalidateSession();
                  if (error.status !== 404) retireSession(id);
                  // A prompt still being spoken must not keep inviting a reply to a dead session.
                  cancelSpeech();
                  renderLatency(startedAt, voiceClock(), true);
                  renderNotice(error.status === 404
                    ? "Voice session expired or is no longer available. Submit a fresh command; nothing was retried."
                    : "Voice service unavailable. Submit a fresh command to reconnect.");
                });
            });
            state.commandQueue = command;
            return command;
          }
          function updateMicrophoneControls() {
            if (enableBtn) enableBtn.disabled = !caps.recognition || !!state.recognition || state.profilePending || state.profileFailed;
          }
          function interruptRecognition() {
            var recognition = state.recognition;
            state.recognition = null;
            state.recognitionGeneration += 1;
            // Invalidate callbacks before abort, which may itself deliver queued events.
            if (recognition) try { recognition.abort(); } catch (error) { /* best-effort */ }
            updateMicrophoneControls();
          }
          function cancelSpeech() {
            speechGeneration += 1;
            if (speechInFlight) speechStatus("Spoken output stopped.");
            speechInFlight = false;
            if (caps.synthesis) try { window.speechSynthesis.cancel(); } catch (error) { /* best-effort */ }
          }
          function settledWithin(promise, ms) {
            return new Promise(function (resolve) {
              var timer = setTimeout(function () { resolve(false); }, ms);
              promise.then(
                function () { clearTimeout(timer); resolve(true); },
                function () { clearTimeout(timer); resolve(true); },
              );
            });
          }
          function switchProfile(profile) {
            var previousCommands = state.commandQueue;
            var id = invalidateSession();
            var generation = state.generation;
            state.profilePending = true;
            state.profileFailed = false;
            interruptRecognition();
            cancelSpeech();
            renderNotice("Changing voice profile. Commands are paused until the server acknowledges it.");
            // Do not let an already-sent utterance arrive in a different profile on this id.
            // If it never settles, give up on the id: retire it and start a fresh session.
            (id ? settledWithin(previousCommands, PROFILE_SWITCH_WAIT_MS) : Promise.resolve(true))
              .then(function (settled) {
                if (generation !== state.generation || !settled) retireSession(id);
                if (generation !== state.generation) return null;
                var path = id && settled ? "/sessions/" + encodeURIComponent(id) + "/profile" : "/sessions";
                return api(path, { method: "POST", body: JSON.stringify({ profile: profile }) }).then(readResponse);
              })
              .then(function (data) {
                if (!data) return;
                var acknowledgedId = acknowledgedSession(data, profile);
                if (generation !== state.generation) { retireSession(acknowledgedId); return; }
                state.sessionId = acknowledgedId;
                state.profile = profile;
                state.profilePending = false;
                renderProfiles();
                renderCommands();
                updateMicrophoneControls();
                renderNotice("Voice profile ready: " + profile.toUpperCase() + ". Submit a fresh command.");
              })
              .catch(function () {
                retireSession(id);
                if (generation !== state.generation) return;
                state.profilePending = false;
                state.profileFailed = true;
                updateMicrophoneControls();
                renderNotice("Voice profile change failed. Select a profile to retry before sending commands.");
              });
          }
          function renderCommands() {
            var list = document.getElementById("voice-command-list");
            var label = document.getElementById("voice-profile-label");
            if (label) label.textContent = state.profile.toUpperCase();
            if (!list) return;
            list.replaceChildren();
            var commands = state.catalog.filter(function (command) { return command.profile === state.profile; });
            if (!commands.length) {
              var none = document.createElement("div");
              none.textContent = "No commands loaded.";
              list.append(none);
              return;
            }
            commands.forEach(function (command) {
              var row = document.createElement("div");
              row.className = "operations-row";
              var title = document.createElement("strong");
              title.textContent = command.phrases[0];
              var meta = document.createElement("small");
              meta.textContent = command.summary + (command.criticality === "critical" ? " · CRITICAL" : "");
              row.append(title, meta);
              list.append(row);
            });
          }
          function renderProfiles() {
            root.replaceChildren();
            VOICE_PROFILES.forEach(function (profile) {
              var button = document.createElement("button");
              button.type = "button";
              button.className = "voice-profile" + (profile === state.profile ? " active" : "");
              button.textContent = profile;
              button.addEventListener("click", function () {
                switchProfile(profile);
              });
              root.append(button);
            });
          }
          function startRecognition() {
            var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!Recognition || state.recognition || state.profilePending || state.profileFailed) return;
            var recognition = new Recognition();
            var recognitionGeneration = ++state.recognitionGeneration;
            state.recognition = recognition;
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.maxAlternatives = 5;
            recognition.lang = "en-AU";
            recognition.onresult = function (event) {
              if (state.recognition !== recognition || recognitionGeneration !== state.recognitionGeneration) return;
              var transcript = "";
              for (var i = event.resultIndex; i < event.results.length; i += 1) {
                transcript += event.results[i][0].transcript;
              }
              var heard = document.getElementById("voice-transcript");
              if (heard) heard.textContent = transcript || "—";
              var recognitionResult = finalVoiceRecognition(event);
              if (!recognitionResult) return;
              var prepared = prepareVoiceDispatch(
                recognitionResult.transcript,
                true,
                recognitionResult.alternatives,
                WAKE_WORDS,
              );
              if (prepared) dispatch(prepared.transcript, prepared.isFinal, prepared.alternatives, prepared.heardTranscript);
            };
            var startedAt = voiceClock();
            var recognitionError = "";
            recognition.onerror = function (event) {
              if (state.recognition !== recognition || recognitionGeneration !== state.recognitionGeneration) return;
              var observed = (event && event.error) || "unknown";
              // The first terminal or unknown code is kept: a later recoverable code must not
              // downgrade it, and a later terminal code must not replace its notice.
              if (RECOGNITION_RECOVERABLE_ERRORS.indexOf(recognitionError) >= 0) recognitionError = observed;
            };
            recognition.onend = function () {
              // Stop, a profile switch and an explicit restart all advance the generation first,
              // so only an ending the browser chose on its own reaches the code below.
              if (state.recognition !== recognition || recognitionGeneration !== state.recognitionGeneration) return;
              state.recognition = null;
              var stopNotice = Object.prototype.hasOwnProperty.call(RECOGNITION_STOP_NOTICES, recognitionError)
                ? RECOGNITION_STOP_NOTICES[recognitionError]
                : "";
              state.recognitionShortEnds =
                voiceClock() - startedAt < RECOGNITION_SHORT_END_MS ? state.recognitionShortEnds + 1 : 0;
              var recoverable = RECOGNITION_RECOVERABLE_ERRORS.indexOf(recognitionError) >= 0;
              if (recoverable && state.recognitionShortEnds < RECOGNITION_SHORT_END_LIMIT) {
                // The browser ends a recognition session after a silence or a network
                // interruption. The microphone stays on until the operator presses Stop.
                startRecognition();
                // A profile switch in flight declines the restart; the control must then be usable again.
                if (!state.recognition) updateMicrophoneControls();
                return;
              }
              state.recognitionShortEnds = 0;
              updateMicrophoneControls();
              renderNotice(stopNotice
                ? "Microphone stopped: " + stopNotice + " (" + recognitionError + "). Enable the microphone again to resume."
                : !recoverable
                  ? "Microphone stopped: speech recognition ended with an unexpected error (" + recognitionError + "). Enable the microphone again to resume."
                  : "Microphone stopped: speech recognition keeps ending" + (recognitionError ? " (" + recognitionError + ")" : "") + ". Check the connection, then enable the microphone again.");
            };
            try { recognition.start(); }
            catch (error) {
              state.recognition = null;
              renderNotice("Microphone unavailable. Use typed commands or enable the microphone again.");
            }
            updateMicrophoneControls();
          }
          if (enableBtn)
            enableBtn.addEventListener("click", function () {
              state.recognitionShortEnds = 0;
              startRecognition();
            });
          if (stopBtn)
            stopBtn.addEventListener("click", function () {
              retireSession(invalidateSession());
              state.profilePending = false;
              state.profileFailed = false;
              interruptRecognition();
              cancelSpeech();
              renderNotice("Voice stopped. Submit a fresh command or enable the microphone to resume.");
            });
          var typed = document.getElementById("voice-typed");
          if (typed)
            typed.addEventListener("submit", function (event) {
              event.preventDefault();
              var input = document.getElementById("voice-text");
              var value = input ? input.value.trim() : "";
              if (!value) return;
              if (input) input.value = "";
              dispatch(value, true);
            });
          api("/catalog")
            .then(readResponse)
            .then(function (data) { state.catalog = Array.isArray(data.commands) ? data.commands : []; renderCommands(); })
            .catch(function () { /* catalog is best-effort; typed fallback still works */ });
          renderProfiles();
          renderCommands();
        }
        // END voice-console (#567)
        const hudPanelRegistry = [];
        function registerHudPanel(panel) {
          if (!panel || typeof panel.id !== "string" || panel.id.length === 0 || panel.id.length > 64) return false;
          if (!/^[a-z0-9-]+$/.test(panel.id)) return false;
          if (hudPanelRegistry.some((item) => item.id === panel.id)) return false;
          hudPanelRegistry.push({
            id: panel.id,
            zone: typeof panel.zone === "string" ? panel.zone : "workspace",
            mount: typeof panel.mount === "string" ? panel.mount : "",
            title: typeof panel.title === "string" ? panel.title : panel.id,
            render: typeof panel.render === "function" ? panel.render : null,
          });
          return true;
        }
        function seedHudPanels() {
          [
            { id: "readiness", zone: "rail", mount: "ready-layer-count", title: "Readiness" },
            { id: "crew", zone: "rail", mount: "panel-crew", title: "Crew" },
            { id: "now", zone: "now", mount: "current-task", title: "Now" },
            { id: "next", zone: "next", mount: "focus-queue", title: "Next 3" },
            { id: "ops", zone: "rail", mount: "right-provider", title: "Ops" },
            { id: "upcoming", zone: "rail", mount: "right-reminder-list", title: "Upcoming" },
            { id: "recent", zone: "rail", mount: "activity-list", title: "Recent" },
            { id: "operations", zone: "workspace", mount: "view-operations", title: "Operations" },
            { id: "live-work", zone: "workspace", mount: "view-livework", title: "Live work" },
            { id: "systems", zone: "workspace", mount: "view-systems", title: "Systems" },
            { id: "presence", zone: "workspace", mount: "hud-presence", title: "Presence" },
            { id: "approvals", zone: "workspace", mount: "approvals-stage", title: "Approvals" },
          ].forEach((panel) => registerHudPanel(panel));
        }
        if (typeof window !== "undefined") {
          window.JarvisHud = {
            registerPanel: registerHudPanel,
            panels: () => hudPanelRegistry.map((panel) => ({ id: panel.id, zone: panel.zone, mount: panel.mount, title: panel.title })),
          };
        }
        // END hud-team-board
        // BEGIN hud-backdrop
        function startHudBackdrop() {
          const canvas = byId("hud-backdrop");
          if (!canvas || !canvas.getContext) return;
          const ctx = canvas.getContext("2d");
          let raf = 0;
          let severity = document.body.dataset.backdropSeverity || "UNKNOWN";
          function reduced() {
            const motion = document.documentElement.dataset.consoleMotion;
            if (motion === "reduce") return true;
            if (motion && motion !== "system") return false;
            return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          }
          function resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
            const cssW = window.innerWidth;
            const cssH = window.innerHeight;
            const cap = 1920 * 1080;
            const scale = Math.min(1, Math.sqrt(cap / Math.max(1, cssW * cssH * dpr * dpr)));
            canvas.width = Math.max(1, Math.floor(cssW * dpr * scale));
            canvas.height = Math.max(1, Math.floor(cssH * dpr * scale));
            canvas.style.width = cssW + "px";
            canvas.style.height = cssH + "px";
          }
          function palette() {
            if (severity === "STOPPED") return { trace: [255, 122, 110], pulse: [255, 92, 117], speed: 1.45 };
            if (severity === "WARN") return { trace: [217, 137, 56], pulse: [255, 176, 90], speed: 0.95 };
            if (severity === "OK") return { trace: [168, 197, 139], pulse: [196, 214, 160], speed: 0.42 };
            return { trace: [154, 146, 134], pulse: [184, 176, 162], speed: 0.2 };
          }
          function ink(rgb, alpha) {
            return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha + ")";
          }
          function calmAt(x, y, w, h) {
            const dx = (x / w - 0.5) / 0.22;
            const dy = (y / h - 0.4) / 0.18;
            return dx * dx + dy * dy < 1 ? 0.62 : 1;
          }
          function draw(time) {
            const w = canvas.width;
            const h = canvas.height;
            const pal = palette();
            const still = reduced();
            const t = still ? 0 : time * 0.001 * pal.speed;
            ctx.clearRect(0, 0, w, h);
            const veil = severity === "STOPPED" ? 0.18 : severity === "WARN" ? 0.08 : severity === "OK" ? 0.03 : 0.06;
            ctx.fillStyle = ink(pal.trace, veil);
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 4; i += 1) {
              const drift = still ? w * (0.15 + i * 0.2) : ((t * 22 + i * 240) % (w + 280)) - 140;
              const y = h * (0.08 + i * 0.05);
              ctx.fillStyle = "rgba(255, 220, 186, " + (0.06 * calmAt(w * 0.4, y, w, h)).toFixed(3) + ")";
              ctx.beginPath();
              ctx.ellipse(drift, y, w * 0.11, h * 0.028, 0, 0, Math.PI * 2);
              ctx.fill();
            }
            const horizon = h * 0.46;
            for (let i = 0; i < 36; i += 1) {
              const x = ((i * 97) % 1000) / 1000 * w;
              const y = horizon + ((i * 13) % 11) * (h * 0.006);
              const glow = still ? 0.28 : 0.12 + 0.7 * Math.abs(Math.sin(t * 1.6 + i));
              ctx.fillStyle = "rgba(255, 214, 140, " + (glow * 0.5 * calmAt(x, y, w, h)).toFixed(3) + ")";
              ctx.fillRect(x, y, Math.max(2, w / 520), Math.max(2, h / 300));
            }
            const waterTop = h * 0.62;
            for (let row = 0; row < 6; row += 1) {
              const y = waterTop + row * (h * 0.038);
              ctx.strokeStyle = "rgba(186, 230, 236, " + (0.26 * calmAt(w * 0.5, y, w, h)).toFixed(3) + ")";
              ctx.lineWidth = Math.max(1, w / 1100);
              ctx.beginPath();
              for (let x = 0; x <= w; x += Math.max(8, w / 90)) {
                const wave = still ? 0 : Math.sin(x * 0.018 + t * 1.4 + row) * (2 + row * 0.5);
                if (x === 0) ctx.moveTo(x, y + wave);
                else ctx.lineTo(x, y + wave);
              }
              ctx.stroke();
            }
            const links = [
              [0.62, 0.7, 0.74, 0.62],
              [0.74, 0.62, 0.84, 0.72],
              [0.7, 0.78, 0.84, 0.72],
            ];
            links.forEach((link, index) => {
              const alpha = still ? 0.35 : 0.25 + 0.45 * Math.abs(Math.sin(t * 1.8 + index));
              ctx.strokeStyle = ink(pal.pulse, alpha);
              ctx.lineWidth = Math.max(1.5, w / 700);
              ctx.beginPath();
              ctx.moveTo(w * link[0], h * link[1]);
              ctx.lineTo(w * link[2], h * link[3]);
              ctx.stroke();
            });
            ctx.fillStyle = ink(pal.trace, 0.75);
            ctx.font = Math.max(12, Math.floor(w / 120)) + "px sans-serif";
            ctx.fillText(still ? "INSTRUMENT STILL" : "INSTRUMENT LIVE", 36, h - 14);
          }
          function loop(time) {
            if (document.hidden) { raf = 0; return; }
            draw(time || 0);
            if (reduced()) { raf = 0; return; }
            raf = window.requestAnimationFrame(loop);
          }
          function kick() {
            if (raf) window.cancelAnimationFrame(raf);
            raf = 0;
            resize();
            if (document.hidden) return;
            raf = window.requestAnimationFrame(loop);
          }
          window.addEventListener("resize", kick);
          document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
              if (raf) window.cancelAnimationFrame(raf);
              raf = 0;
              return;
            }
            kick();
          });
          const watch = new MutationObserver(() => {
            severity = document.body.dataset.backdropSeverity || "UNKNOWN";
            if (!raf && !document.hidden) kick();
          });
          watch.observe(document.body, { attributes: true, attributeFilter: ["data-backdrop-severity"] });
          watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-console-motion"] });
          const media = window.matchMedia("(prefers-reduced-motion: reduce)");
          if (media.addEventListener) media.addEventListener("change", kick);
          kick();
        }
        // END hud-backdrop

        function setCaptureMode(mode) { state.captureMode = mode; document.querySelectorAll("[data-capture]").forEach((button) => button.classList.toggle("active",button.dataset.capture === mode)); const category = byId("capture-category"); const due = byId("capture-due"); if (mode === "task") { text(byId("capture-title-label"),"Task command"); text(byId("capture-detail-copy"),"Category"); category.hidden = false; due.hidden = true; text(byId("capture-submit"),"ADD TASK"); } else { text(byId("capture-title-label"),"Reminder command"); text(byId("capture-detail-copy"),"When"); category.hidden = true; due.hidden = false; text(byId("capture-submit"),"SET REMINDER"); } }
        document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click",() => { document.querySelectorAll("[data-view]").forEach((candidate) => candidate.classList.toggle("active",candidate === button)); document.body.dataset.consoleView = button.dataset.view || "focus"; document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active",view.id === `view-${button.dataset.view}`)); }));
        const settingsTabByHash = { "view-general": "general", "view-credentials": "credentials", "view-persistence": "persistence", "view-limits": "limits", "view-danger": "danger" };
        function showSettingsTab(tab) { document.querySelectorAll("[data-settings-tab]").forEach((candidate) => { const selected = candidate.dataset.settingsTab === tab; candidate.classList.toggle("active", selected); if (selected) candidate.setAttribute("aria-current", "page"); else candidate.removeAttribute("aria-current"); }); document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.settingsPanel === tab)); if (tab === "persistence") void loadPersistence(); }
        (function wireToday() {
          const more = byId("rail-more"); const toggle = byId("rail-more-toggle");
          const setMore = (open) => { if (!more || !toggle) return; more.hidden = !open; toggle.setAttribute("aria-expanded", open ? "true" : "false"); };
          if (toggle) toggle.addEventListener("click", () => setMore(more.hidden));
          if (more && [...more.querySelectorAll("[data-view]")].some((button) => button.dataset.view === document.body.dataset.consoleView)) setMore(true);
          const talk = byId("today-talk"); if (talk) talk.addEventListener("click", () => { const voice = document.querySelector("[data-view=voice]"); if (voice) voice.click(); });
          const form = byId("today-add"); if (!form) return;
          const submit = async (kind) => {
            const titleEl = byId("today-add-title"); const whenEl = byId("today-add-when");
            const title = titleEl.value.trim(); const when = whenEl.value.trim();
            if (!title) { titleEl.focus(); return; }
            const buttons = form.querySelectorAll("button"); buttons.forEach((button) => { button.disabled = true; });
            try {
              if (kind === "reminder") {
                const result = await callTool("create_reminder", Object.assign({ title }, when ? { due: { text: when } } : {}));
                const data = structured(result) || {};
                const created = data.created || data.reminder || null;
                if (when && created && typeof created.dueAt !== "number") toast("Saved " + title + ", but I couldn't work out when “" + when + "” is, so it won't go off. Try something like “tomorrow 3pm” or “in 2 hours”.", true);
                else toast("Okay, I'll remind you: " + title + (created && typeof created.dueAt === "number" ? ", " + todayDue(created) : "") + ".");
              }
              else if (kind === "errand") { await callTool("create_errand", { title }); toast("Got it. " + title + " is on your errands."); callTool("show_jarvis_dashboard").catch(() => { /* the next poll catches up */ }); }
              else { await callTool("create_task", { title, category: "personal" }); toast("Done. " + title + " is on your list."); }
              titleEl.value = ""; whenEl.value = "";
            } catch { toast("Sorry, I couldn't add that " + kind + ".", true); }
            finally { buttons.forEach((button) => { button.disabled = false; }); }
          };
          form.addEventListener("submit", (event) => { event.preventDefault(); void submit(byId("today-add-when").value.trim() ? "reminder" : "task"); });
          form.querySelector('[data-today-add="reminder"]').addEventListener("click", () => { void submit("reminder"); });
          form.querySelector('[data-today-add="errand"]').addEventListener("click", () => { void submit("errand"); });
        })();
        function activateNamedView(name) { document.body.dataset.consoleView = name; document.querySelectorAll("[data-view]").forEach((candidate) => candidate.classList.toggle("active", candidate.dataset.view === name)); document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`)); }
        function applySettingsHash() { const tab = settingsTabByHash[location.hash.slice(1)]; if (!tab) return; activateNamedView("settings"); showSettingsTab(tab); }
        window.addEventListener("hashchange", applySettingsHash);
        applySettingsHash();
        document.querySelectorAll("[data-settings-jump]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); const tab = link.getAttribute("data-settings-jump"); activateNamedView("settings"); showSettingsTab(tab); const target = document.querySelector(link.getAttribute("href")); if (target instanceof HTMLElement) target.focus(); }));
        document.querySelectorAll("[data-capture]").forEach((button) => button.addEventListener("click",() => setCaptureMode(button.dataset.capture)));
        byId("refresh").addEventListener("click",async () => { const button = byId("refresh"); button.disabled = true; try { await callTool("show_jarvis_dashboard"); try { update(await request("tools/call", { name: "get_general_settings", arguments: {} }, 10000)); } catch { state.generalSettings = null; renderGeneral(); } void loadPersistence(); activity("Snapshot refreshed","Live dashboard state reloaded"); toast("NOLAN HUD refreshed."); } catch { toast("NOLAN refresh failed.",true); } finally { button.disabled = false; } });
        byId("save-display-preferences").addEventListener("click", saveDisplayPreferences);
        const savedDisplay = loadSavedDisplayPreferences();
        applyConsoleDisplayPreferences(savedDisplay, document.documentElement);
        syncDisplayForm(savedDisplay);
        byId("persistence-refresh").addEventListener("click", () => { void loadPersistence(); });
        document.querySelectorAll("[data-persistence-cancel]").forEach((button) => button.addEventListener("click", () => { const dialog = button.closest("[data-persistence-dialog]"); if (dialog) dialog.hidden = true; }));
        byId("persistence-backup").addEventListener("click", () => openPersistenceDialog("persistence-dialog-export-classic"));
        byId("persistence-export-v4").addEventListener("click", () => { const blocked = byId("persistence-export-v4-blocked"); const refusal = persistenceView && persistenceView.backup.v4ExportRefusal; blocked.hidden = !refusal; text(blocked, refusal || ""); byId("persistence-export-v4-submit").disabled = Boolean(refusal); openPersistenceDialog("persistence-dialog-export-v4"); });
        byId("persistence-verify-classic").addEventListener("click", () => openPersistenceDialog("persistence-dialog-verify-classic"));
        byId("persistence-verify-v4").addEventListener("click", () => openPersistenceDialog("persistence-dialog-verify-v4"));
        byId("persistence-restore-classic").addEventListener("click", () => openPersistenceDialog("persistence-dialog-restore-classic"));
        byId("persistence-restore-v4").addEventListener("click", () => openPersistenceDialog("persistence-dialog-restore-v4"));
        byId("persistence-resume-v4").addEventListener("click", () => { byId("persistence-resume-v4-submit").disabled = true; text(byId("persistence-resume-v4-result"), "Check the destination. Resume stays disabled until it is an interrupted restore of this archive."); openPersistenceDialog("persistence-dialog-resume-v4"); });
        byId("persistence-export-classic-submit").addEventListener("click", () => { void runPersistence("export-classic", { file: byId("persistence-export-classic-file").value.trim() }, "persistence-export-classic-result"); });
        byId("persistence-export-v4-submit").addEventListener("click", () => { void runPersistence("export-v4", { file: byId("persistence-export-v4-file").value.trim() }, "persistence-export-v4-result"); });
        byId("persistence-verify-classic-submit").addEventListener("click", () => { void runPersistence("verify-classic", { file: byId("persistence-verify-classic-file").value.trim() }, "persistence-verify-classic-result"); });
        byId("persistence-verify-v4-submit").addEventListener("click", () => { void runPersistence("verify-v4", { file: byId("persistence-verify-v4-file").value.trim() }, "persistence-verify-v4-result"); });
        byId("persistence-restore-classic-submit").addEventListener("click", () => { void runPersistence("restore-classic", { file: byId("persistence-restore-classic-file").value.trim(), confirmEmptyTarget: true, understandIdsRecreated: byId("persistence-restore-classic-ack").checked, typedConfirmation: byId("persistence-restore-classic-phrase").value.trim() }, "persistence-restore-classic-result"); });
        byId("persistence-restore-v4-submit").addEventListener("click", () => { void runPersistence("restore-v4", { file: byId("persistence-restore-v4-file").value.trim(), destination: byId("persistence-restore-v4-dir").value.trim(), allowPartial: byId("persistence-restore-v4-partial").checked, acknowledgePartial: byId("persistence-restore-v4-ack").checked, resume: false, typedConfirmation: byId("persistence-restore-v4-phrase").value.trim() }, "persistence-restore-v4-result"); });
        byId("persistence-resume-v4-check").addEventListener("click", async () => { const outcome = await runPersistence("inspect-v4-destination", { file: byId("persistence-resume-v4-file").value.trim(), destination: byId("persistence-resume-v4-dir").value.trim() }, "persistence-resume-v4-result"); byId("persistence-resume-v4-submit").disabled = !(outcome && outcome.destination && outcome.destination.resumeAvailable); });
        byId("persistence-resume-v4-submit").addEventListener("click", () => { void runPersistence("resume-v4", { file: byId("persistence-resume-v4-file").value.trim(), destination: byId("persistence-resume-v4-dir").value.trim(), allowPartial: byId("persistence-resume-v4-partial").checked, acknowledgePartial: byId("persistence-resume-v4-ack").checked, resume: true, typedConfirmation: byId("persistence-resume-v4-phrase").value.trim() }, "persistence-resume-v4-result"); });
        function setCaptureDrawer(open) {
          const drawer = byId("capture-drawer"), toggle = byId("capture-toggle");
          drawer.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
          if (open) byId("capture-title").focus(); else toggle.focus();
        }
        byId("capture-toggle").addEventListener("click", () => setCaptureDrawer(byId("capture-drawer").hidden));
        document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !byId("capture-drawer").hidden) setCaptureDrawer(false); });
        byId("capture-form").addEventListener("submit",async (event) => { event.preventDefault(); const input = byId("capture-title"); const title = input.value.trim(); if (!title) return; const button = byId("capture-submit"); button.disabled = true; try { if (state.captureMode === "task") { await callTool("create_task",{ title, category: byId("capture-category").value }); activity("Task captured",title); toast(`Added ${title}`); } else { const due = byId("capture-due").value.trim(); await callTool("create_reminder",{ title, ...(due ? { due: { text: due } } : {}) }); byId("capture-due").value = ""; activity("Reminder captured",title); toast(`Added reminder ${title}`); } input.value = ""; } catch { toast(state.captureMode === "task" ? "Could not add that task." : "Could not add that reminder.",true); } finally { button.disabled = false; } });
        function clock() { text(byId("clock"),new Date().toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})); }
        bridgeReady.then(async () => { try { update(await request("tools/call", { name: "get_general_settings", arguments: {} }, 10000)); } catch { state.generalSettings = null; renderGeneral(); } }).catch(() => {});
        bridgeReady.catch(() => { activity("HUD bridge failed","ChatGPT Apps bridge did not initialise"); toast("The ChatGPT app bridge did not initialise.",true); });
        document.addEventListener("visibilitychange",() => { if (document.visibilityState !== "visible") return; void checkConnectionHealth(true); });
        seedHudPanels(); setCaptureMode("task"); render(); startHudBackdrop(); setupVoiceConsole(); clock(); window.setInterval(clock,1000); window.setInterval(checkConnectionHealth,15000);
      })();
    