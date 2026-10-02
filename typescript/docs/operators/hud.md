# Operator HUD (Console 02)

The operator HUD is `src/mcp/dashboard-v1.html`, served as the MCP widget
`ui://jarvis/dashboard-v1.html`. It is a projection over the Jarvis HTTP API.
It does not own tasks, reminders, quotes, approvals, or missions.

On a loopback bind the HTTP server also serves the same page at `GET /hud`
(for example `http://127.0.0.1:3000/hud`). That route is public only because
the bind is loopback. The HTML contains no token. The page fetches
`GET /api/v1/hud/snapshot` with no `Authorization` header and refuses write
tools. A non-loopback bind returns 404 for both routes. Open a file preview
with `src/mcp/dashboard-preview-host.html`. That host iframes the widget and
does not inject a sample snapshot.

## Layout

Console 02 is the 55-inch landscape frame: a chamfered brass bezel drawn as
an SVG stroke (so the coast stays visible), heavy rivets, and a domed title
plate `JARVIS TOTALITY` / `CONSOLE 02` that breaks the top edge. The engraved
sub-plate reads `OPTIMIZED TOTALITY STATE`. The live reading under it is
`status.status`, or `UNKNOWN` until status arrives. Smoked glass with amber
corner brackets sits over a photographic dusk coast
(`src/mcp/assets/coast-dusk.jpg`, inlined so the widget stays one file).
Empty meters still draw their chrome: ring ticks, chart grids, parked dial
needles, and an unlabelled tactical node sketch. The reading stays `UNKNOWN`.
On a 1920×1080 desktop the brand sits inside the left of the frame, the chips
sit inside the right, and the nav is one row under the title so it does not
cover either. Desktop, tablet, and phone collapse the same regions; they do
not get a second data model.

| Zone      | What it shows                                                              | Mount                               |
| --------- | -------------------------------------------------------------------------- | ----------------------------------- |
| Now       | The first active durable task and its one primary action (`complete_task`) | `#current-task`, `#current-actions` |
| Next 3    | The following active tasks, at most three                                  | `#focus-queue`                      |
| Readiness | Runtime layers from `status.layers`                                        | `#readiness-percent`                |
| Crew      | Always `UNKNOWN`. Jarvis has no crew roster                                | `#panel-crew`                       |
| Ops       | Persistence reachability, authentication, schema                           | `#right-provider`                   |
| Upcoming  | Next reminders                                                             | `#right-reminder-list`              |
| Recent    | This session's operator feed                                               | `#activity-list`                    |

Other views stay on the top rail: Task Board, Reminders, Operations, Live Work,
Systems, Settings. Operations is the business and home projection (projects,
quotes, enquiries, invoices, errands, scheduled jobs, inbox, activity). Do not
add a parallel Home or Business view that reads a second way.

The primary action stays **clear task**. The concept's "Start" button is not a
Jarvis operation, so it is not on the board.

## NOW chip and backdrop

There is one limits NOW chip, `#limits-now-chip`, ranked
`STOPPED > UNKNOWN > WARN > OK > NO LIMIT`. It links to `/settings/limits` and
is not editable. While the quota store is unread the chip stays `UNKNOWN`.

Console 02 plates that have no Jarvis meter stay parked. Predictor Core draws
task counts by category only after `tasks` arrives. Waveform Analysis has no
signal, so the line stays flat. Host, memory, store, and link dials, System
Load, and System Efficiency have no host meter, so the needles stay parked and
the caption stays `UNKNOWN`. System Overview uses layer readiness, persistence
reachability, and `zState` as words, not invented percents. Data List is
`status.integrations` stages. The numeric tiles are active tasks, reminders,
and inbox item count. Network Integrity shows `status.version`. Tactical
Overlay lists inbox item titles and does not invent facility names. Core
Analyzer sliders show persistence, z-state, limits, presence, and live work
as words, with thumbs parked.

The instrument backdrop is separate. `deriveBackdropSeverity` uses the same
rank on readings that actually arrived:

- no status yet → `UNKNOWN` (grey, slow)
- `status` unavailable or `zState` suspended, or a critical inbox item, or limits `STOPPED` → `STOPPED`
- degraded status, high/elevated inbox item, live-work `REPAIR_REQUIRED` or `INDETERMINATE`, or limits `WARN` → `WARN`
- status `ok` → `OK` (sage, calm)

An unread limits chip does not grey out a known runtime. Unread is not a
measured outage. The plate is the committed dusk photograph. Severity tints
that photograph. The canvas stays transparent and draws drifting cloud,
surf shimmer, window twinkle, and pulsing links. It never draws
telemetry numbers. It pauses while `document.hidden` is true, and it draws one
still frame labelled `INSTRUMENT STILL` when `data-console-motion="reduce"` or
`prefers-reduced-motion: reduce` applies. Internal pixels stay at or under
1920×1080.

## Data contract

Every value comes from the dashboard snapshot (`show_jarvis_dashboard`) or from
a tool the widget already calls. Until that field has been received, the board
says `UNKNOWN`, `CONNECTING`, or `NONE` after a real empty read. It does not
keep sample people, sample counts, or a fixture snapshot.

| Reading                                                                  | Source                                                  | Before the read                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| Tasks, reminders, brief, quotes, inbox, activity, live work, credentials | Dashboard snapshot                                      | Unknown / unavailable, not an empty success           |
| Load chip                                                                | `tasks` array received                                  | `Load · UNKNOWN`                                      |
| Next chip                                                                | `reminders` array received                              | `Next · UNKNOWN`; `NONE` only after a real empty list |
| Presence                                                                 | `deriveHudPresence(status)` in `src/hud/hudPresence.ts` | `CONNECTING`                                          |
| Approvals                                                                | Operations inbox `toolActions` source only              | `UNKNOWN`                                             |

Presence does not invent `listening`, `processing`, or `executing`. Those need
a runtime field that `SystemStatus` does not have.

Approvals are inspect-only. `src/hud/hudApprovalLifecycle.ts` maps proposal,
inspection, receipt, and reconciliation into display stages. Missing receipt
observation is `OUTCOME UNKNOWN`, not failure. The widget does not call
approve, reject, or execute, and it does not store `JARVIS_APPROVAL_TOKEN`.
`canSubmitApproval` means the HTTP operator path could accept a decision. It
does not authorise the widget. The dashboard snapshot has no proposal list, so
the Approvals panel reports the inbox source status instead of scanning every
project.

## Adding a panel

Built-in panels are registered by `seedHudPanels`. Add another from the widget
console, or from a script that runs after the widget loads:

```javascript
window.JarvisHud.registerPanel({
  id: "shed-queue",
  zone: "rail",
  mount: "shed-queue-list",
  title: "Shed queue",
  render(state) {
    const mount = document.getElementById("shed-queue-list");
    if (!mount) return;
    mount.replaceChildren();
    const reading = state.brief && state.brief.errands;
    if (!reading) {
      mount.textContent = "UNKNOWN";
      return;
    }
    // Render reading.open with textContent. Do not invent a count.
  },
});
```

Rules:

1. `id` is lowercase letters, digits, and hyphens, at most 64 characters.
2. Put the mount element in `dashboard-v1.html` and give it a `data-hud-panel`.
3. Write with `textContent`. Do not use `innerHTML`.
4. If the field is missing, show `UNKNOWN` or the existing unavailable copy.
5. Do not add a delete control, a credential, or a new write tool.
6. Extension `render` runs at the end of `render()`. A throw leaves the mount
   as it was.

Tokens already on the board: cream `#e8dfd0`, brass `#d98938`, sage `#a8c58b`,
danger `#ff5c75`, glass `rgba(6, 10, 16, 0.36)`. The older warm-instrument
stops `#c47b4a`, `#d7a15f`, `#ff7a18` stay in `--violet`, `--green`, `--orange`,
and `--brand-gradient`. From 1400px wide the header chrome tightens so the
frame fits a 1920×1080 display. Settings controls stay at least 44px.

## What came from the earlier HUD snapshots

From the Codex snapshot, adapted to current `main`:

- `src/hud/hudPresence.ts` and `src/hud/hudApprovalLifecycle.ts`, with their tests
- the approvals boundary (inspect on the HUD, decide on the HTTP operator path)
- a preview host that only iframes the real widget

Not carried over, because they would regress fail-closed behaviour or duplicate
a view `main` already has:

- the preview host's hard-coded tasks, reminders, and presence fixture
- separate Home / Work / Business views (Operations already projects those registers)
- widget approve / reject / execute controls

Claude's snapshot was an earlier `dashboard-v1.html`. Current `main` already
has the operations inbox, activity timeline, live work, quote inspector,
errands, scheduled jobs, and the settings rail. Nothing in that file was ahead
of `main`, so no Claude panel was copied in.

## Safety

Loopback binding, credential-free widget output, and no delete controls stay as
they are. See [chatgpt-preview.md](chatgpt-preview.md),
[operations-inbox.md](operations-inbox.md), and
[limits-settings.md](limits-settings.md).
