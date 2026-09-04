import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Expand, PictureInPicture } from "@openai/apps-sdk-ui/components/Icon";
import {
  useCallTool,
  useDisplayMode,
  useSendFollowUp,
  useToolContext,
  type ViewConfig,
} from "mcp-use/react";
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import "../styles.css";
import "../phase23.css";
import type {
  JarvisConsoleProps,
  JarvisDevelopmentMission,
  JarvisGovernedAction,
  JarvisNote,
  JarvisReminder,
  JarvisTask,
} from "./types";
import { formatPartialCount, taskProgressLabel } from "../../pagination.js";
import { propSchema } from "./types";

export const viewConfig = {
  displayModes: ["inline", "fullscreen", "pip"],
} satisfies ViewConfig;

const statusClass = (state: "good" | "guarded" | "pending") => `status-chip status-${state}`;

function formatDue(reminder: JarvisReminder) {
  if (reminder.dueAt) return new Date(reminder.dueAt).toLocaleString("en-AU");
  return reminder.dueRaw || "No due time";
}

// Read-only status line. Never fabricates an expiry or reason the record
// doesn't actually carry — falls back to the literal string "UNAVAILABLE".
function formatGovernedActionStatus(action: JarvisGovernedAction) {
  if (action.state === "revoked") return `REVOKED — ${action.revokedReason || "UNAVAILABLE"}`;
  if (action.state === "expired") return "EXPIRED";
  if (action.state === "approved") {
    if (action.isApprovalExpired) return "APPROVAL EXPIRED (pending sync)";
    if (action.approvalExpiresAt) {
      return `APPROVED — expires ${new Date(action.approvalExpiresAt).toLocaleString("en-AU")}`;
    }
    return "APPROVED — UNAVAILABLE expiry";
  }
  return action.state.toUpperCase();
}

const TERMINAL_DEVELOPMENT_STATES = new Set(["COMPLETE", "FAILED", "ABORTED", "CONTRADICTED"]);
const BLOCKED_DEVELOPMENT_STATES = new Set(["REPAIR_REQUIRED", "INDETERMINATE"]);

function developmentMissionStatusClass(mission: JarvisDevelopmentMission) {
  if (TERMINAL_DEVELOPMENT_STATES.has(mission.state)) {
    return statusClass(mission.state === "COMPLETE" ? "good" : "guarded");
  }
  if (BLOCKED_DEVELOPMENT_STATES.has(mission.state)) return statusClass("guarded");
  return statusClass("pending");
}

const JarvisConsole: React.FC = () => {
  const toolContext = useToolContext();
  const isPending = toolContext.status === "pending";
  const props: unknown = toolContext.toolOutput;
  const { displayMode, requestDisplayMode } = useDisplayMode();
  const sendFollowUp = useSendFollowUp();
  const { callTool: refreshConsole, isPending: refreshing } = useCallTool("show-jarvis-console");
  const { callTool: createTask, isPending: creatingTask } = useCallTool("create-jarvis-task");
  const { callTool: completeTask, isPending: completingTask } = useCallTool("complete-jarvis-task");
  const { callTool: createReminder, isPending: creatingReminder } =
    useCallTool("create-jarvis-reminder");
  const { callTool: removeReminder, isPending: removingReminder } =
    useCallTool("remove-jarvis-reminder");
  const { callTool: createNote, isPending: creatingNote } = useCallTool("create-jarvis-note");
  const { callTool: removeNote, isPending: removingNote } = useCallTool("remove-jarvis-note");

  const [snapshot, setSnapshot] = useState<JarvisConsoleProps | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCategory, setTaskCategory] = useState<
    "personal" | "work" | "builds" | "money" | "life"
  >("work");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [command, setCommand] = useState("");
  const [feedback, setFeedback] = useState("Console controls ready.");

  useEffect(() => {
    // toolOutput is untyped under the loose RegisteredTools fallback (this
    // project exports no ToolRef), so validate it against the same schema
    // the server's outputSchema enforces before trusting it as a snapshot.
    if (isPending) return;
    const parsed = propSchema.safeParse(props);
    if (parsed.success) setSnapshot(parsed.data);
  }, [isPending, props]);

  const applyToolResult = (result: unknown, message: string) => {
    const structuredContent =
      typeof result === "object" && result !== null && "structuredContent" in result
        ? (result as { structuredContent?: unknown }).structuredContent
        : undefined;
    const parsed = propSchema.safeParse(structuredContent);
    if (parsed.success) setSnapshot(parsed.data);
    setFeedback(message);
  };

  const activeTasks = useMemo(
    () => snapshot?.tasks.filter((task) => !task.completed) ?? [],
    [snapshot],
  );
  const completedTasks = useMemo(
    () => snapshot?.tasks.filter((task) => task.completed) ?? [],
    [snapshot],
  );

  if (isPending || !snapshot) {
    return (
      <div className="jarvis-shell jarvis-loading">
        <div className="loading-core" />
        <p>Synchronising Jarvis Console 01...</p>
      </div>
    );
  }

  const isExpanded = displayMode === "fullscreen" || displayMode === "pip";
  const currentTask = activeTasks[0];
  // The partial-page marker is intentionally repeated in telemetry and workflow views:
  // formatPartialCount(snapshot.counts.reminders, snapshot.counts.remindersPartial)
  const reminderCountLabel = formatPartialCount(
    snapshot.counts.reminders,
    snapshot.counts.remindersPartial,
  );
  const busy = [
    refreshing,
    creatingTask,
    completingTask,
    creatingReminder,
    removingReminder,
    creatingNote,
    removingNote,
  ].some(Boolean);

  const runRefresh = async () => {
    const result = await refreshConsole({});
    applyToolResult(result, "Live Convex snapshot refreshed.");
  };

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    const title = taskTitle.trim();
    if (!title) return;
    const result = await createTask({ title, category: taskCategory });
    applyToolResult(result, `Task created: ${title}`);
    setTaskTitle("");
  };

  const clearTask = async (task: JarvisTask) => {
    const result = await completeTask({ taskId: task.id });
    applyToolResult(result, `Task completed: ${task.title}`);
  };

  const submitReminder = async (event: React.FormEvent) => {
    event.preventDefault();
    const title = reminderTitle.trim();
    if (!title) return;
    const result = await createReminder({
      title,
      ...(reminderDue.trim() ? { dueRaw: reminderDue.trim() } : {}),
    });
    applyToolResult(result, `Reminder created: ${title}`);
    setReminderTitle("");
    setReminderDue("");
  };

  const dismissReminder = async (reminder: JarvisReminder) => {
    const result = await removeReminder({ reminderId: reminder.id });
    applyToolResult(result, `Reminder removed: ${reminder.title}`);
  };

  const submitNote = async (event: React.FormEvent) => {
    event.preventDefault();
    const title = noteTitle.trim();
    const body = noteBody.trim();
    if (!title || !body) return;
    const result = await createNote({ title, body, domain: "home", sensitivity: "internal" });
    applyToolResult(result, `Note created: ${title}`);
    setNoteTitle("");
    setNoteBody("");
  };

  const dismissNote = async (note: JarvisNote) => {
    const result = await removeNote({ noteId: note.id });
    applyToolResult(result, `Note removed: ${note.title}`);
  };

  const submitCommand = async (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = command.trim();
    if (!prompt) return;
    try {
      await sendFollowUp({
        prompt:
          `Jarvis Console 01 operator note: "${prompt}". Analyse this against the current console ` +
          "snapshot and propose next steps. Console 01 itself exposes no tool beyond show-jarvis-console, " +
          "create-jarvis-task, complete-jarvis-task, create-jarvis-reminder, remove-jarvis-reminder, " +
          "create-jarvis-note, and remove-jarvis-note " +
          "— it has no deploy, infrastructure, or Convex-schema tool of any kind, so treat this as a " +
          "request for analysis and a proposed plan, not an instruction to execute anything outside that set.",
      });
      setFeedback(
        "Note sent to Jarvis for analysis — it cannot execute anything beyond this console's own typed tools.",
      );
      setCommand("");
    } catch {
      setFeedback("Could not send that note to Jarvis — the host declined or the request failed.");
    }
  };

  return (
    <AppsSDKUIProvider linkComponent={Link}>
      <main className="jarvis-shell phase23-shell totality-shell">
        <header className="console-header">
          <div className="brand-lockup">
            <img className="brand-logo" src="/beez-treez-logo.png" alt="The Beez Treez" />
            <div>
              <p className="eyebrow">GOVERNED PROPERTY OPERATIONS</p>
              <h1>JARVIS TOTALITY</h1>
              <span className="console-subtitle">{snapshot.phase}</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="hud-refresh" disabled={busy} onClick={runRefresh} type="button">
              {refreshing ? "SYNCING" : "SYNC"}
            </button>
            <span className={`live-pill live-${snapshot.status}`}>
              {snapshot.status.toUpperCase()}
            </span>
            {!isExpanded ? (
              <>
                <Button
                  color="secondary"
                  pill
                  size="md"
                  uniform
                  variant="outline"
                  onClick={() => void requestDisplayMode({ mode: "pip" })}
                  title="Picture in picture"
                >
                  <PictureInPicture />
                </Button>
                <Button
                  color="secondary"
                  pill
                  size="md"
                  uniform
                  variant="outline"
                  onClick={() => void requestDisplayMode({ mode: "fullscreen" })}
                  title="Fullscreen"
                >
                  <Expand />
                </Button>
              </>
            ) : (
              <Button
                color="secondary"
                pill
                size="md"
                variant="outline"
                onClick={() => void requestDisplayMode({ mode: "inline" })}
              >
                EXIT
              </Button>
            )}
          </div>
        </header>

        <section className="telemetry-strip phase23-telemetry totality-status-strip">
          <div>
            <span>CONVEX</span>
            <strong>
              {snapshot.systems.find((system) => system.label === "Convex")?.value ?? "UNKNOWN"}
            </strong>
          </div>
          <div>
            <span>ACTIVE TASKS</span>
            <strong>
              {formatPartialCount(snapshot.counts.active, snapshot.counts.tasksPartial)}
            </strong>
          </div>
          <div>
            <span>REMINDERS</span>
            <strong>
              {formatPartialCount(snapshot.counts.reminders, snapshot.counts.remindersPartial)}
            </strong>
          </div>
          <div>
            <span>DURABLE STATE</span>
            <strong>
              {formatPartialCount(
                snapshot.counts.active + snapshot.counts.reminders + snapshot.counts.notes,
                snapshot.counts.tasksPartial ||
                  snapshot.counts.remindersPartial ||
                  snapshot.counts.notesPartial,
              )}
            </strong>
          </div>
          <div>
            <span>POLICY</span>
            <strong>{snapshot.governedActions.length ? "GOVERNED" : "READY"}</strong>
          </div>
          <div>
            <span>LAST SYNC</span>
            <strong>{new Date(snapshot.lastUpdated).toLocaleTimeString("en-AU")}</strong>
          </div>
        </section>

        <section className="console-grid phase23-grid">
          <aside className="left-rail">
            <div className="hud-panel workflow-panel">
              <div className="panel-title">TASKS / WORKFLOW STATE</div>
              <div className="workflow-row">
                <span>ACTIVE TASKS</span>
                <strong>
                  {formatPartialCount(snapshot.counts.active, snapshot.counts.tasksPartial)}
                </strong>
                <i
                  style={
                    {
                      "--fill": `${Math.min(snapshot.counts.active * 12, 100)}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
              <div className="workflow-row">
                <span>COMPLETED</span>
                <strong>
                  {formatPartialCount(snapshot.counts.completed, snapshot.counts.tasksPartial)}
                </strong>
                <i style={{ "--fill": `${snapshot.progress}%` } as React.CSSProperties} />
              </div>
              <div className="workflow-row">
                <span>REMINDERS</span>
                <strong>{reminderCountLabel}</strong>
                <i
                  style={
                    {
                      "--fill": `${Math.min(snapshot.counts.reminders * 12, 100)}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
              <div className="workflow-row">
                <span>NOTES LOGGED</span>
                <strong>
                  {formatPartialCount(snapshot.counts.notes, snapshot.counts.notesPartial)}
                </strong>
                <i
                  style={
                    {
                      "--fill": `${Math.min(snapshot.counts.notes * 12, 100)}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            </div>

            <div className="hud-panel evidence-panel">
              <div className="panel-title">EVIDENCE / HEALTH</div>
              {snapshot.systems.slice(0, 4).map((system) => (
                <div className="evidence-row" key={system.label}>
                  <span>{system.label}</span>
                  <strong className={`evidence-${system.state}`}>{system.value}</strong>
                </div>
              ))}
            </div>

            <div className="hud-panel task-stack live-task-stack">
              <div className="panel-title">ACTIVE MISSION STACK</div>
              {activeTasks.length === 0 ? (
                <div className="console-empty">Command deck clear.</div>
              ) : (
                activeTasks.slice(0, 6).map((task, index) => (
                  <div className="task-row task-active interactive-row" key={task.id}>
                    <span className="task-index">{String(index + 1).padStart(2, "0")}</span>
                    <div className="row-copy">
                      <strong>{task.title}</strong>
                      <small>{task.category.toUpperCase()}</small>
                    </div>
                    <button type="button" disabled={busy} onClick={() => clearTask(task)}>
                      CLEAR
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          <section className="centre-stage phase23-centre">
            <div className="status-deck" aria-label="Jarvis system status">
              {[
                [
                  "CORE",
                  snapshot.status === "operational" ? "ONLINE" : "DEGRADED",
                  snapshot.status === "operational" ? "good" : "guarded",
                ],
                [
                  "DURABLE STATE",
                  snapshot.systems.some(
                    (system) => system.label === "Convex" && system.state === "good",
                  )
                    ? "AUTHENTICATED"
                    : "PENDING",
                  snapshot.systems.some(
                    (system) => system.label === "Convex" && system.state === "good",
                  )
                    ? "good"
                    : "pending",
                ],
                [
                  "POLICY",
                  snapshot.governedActions.some((action) => action.destructive)
                    ? "GUARDED"
                    : "READY",
                  snapshot.governedActions.some((action) => action.destructive)
                    ? "guarded"
                    : "good",
                ],
              ].map(([label, value, state]) => (
                <div className={`status-ring status-ring-${state}`} key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="mission-copy">
              <p className="eyebrow">PRIMARY MISSION</p>
              <h2>{currentTask?.title || snapshot.mission}</h2>
            </div>

            <div
              className="reactor-stage"
              aria-label={`${snapshot.progress}% ${snapshot.counts.tasksPartial ? "visible-page " : ""}completion progress`}
            >
              <div className="energy-flare flare-a" />
              <div className="energy-flare flare-b" />
              <div className="reactor-ring outer" />
              <div className="reactor-ring middle" />
              <div className="reactor-ring inner" />
              <div
                className="reactor-progress"
                style={{ "--progress": `${snapshot.progress}%` } as React.CSSProperties}
              />
              <div className="reactor-mascot" aria-hidden="true">
                <span className="mascot-eye left" />
                <span className="mascot-eye right" />
                <span className="mascot-mouth" />
              </div>
              <div className="progress-copy">
                <strong>{snapshot.progress}%</strong>
                <span>{taskProgressLabel(snapshot.counts.tasksPartial)}</span>
              </div>
            </div>

            <form className="operator-command" onSubmit={submitCommand}>
              <label htmlFor="operator-command-input">OPERATOR COMMAND</label>
              <div>
                <input
                  id="operator-command-input"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="Ask Jarvis to inspect, plan or propose the next safe action"
                />
                <button type="submit">ROUTE</button>
              </div>
            </form>

            <div className="feedback-strip">{feedback}</div>
          </section>

          <aside className="right-rail">
            <div className="hud-panel approval-panel">
              <div className="panel-title">QUOTES / APPROVALS</div>
              <div className="approval-row">
                <span>GOVERNED ACTIONS</span>
                <strong>{snapshot.governedActions.length}</strong>
              </div>
              <div className="approval-row">
                <span>APPROVED</span>
                <strong>
                  {snapshot.governedActions.filter((action) => action.state === "approved").length}
                </strong>
              </div>
              <div className="approval-row">
                <span>AWAITING DECISION</span>
                <strong>
                  {snapshot.governedActions.filter((action) => action.state === "proposed").length}
                </strong>
              </div>
              <div className="approval-row">
                <span>REMINDERS TRACKED</span>
                <strong>
                  {formatPartialCount(snapshot.counts.reminders, snapshot.counts.remindersPartial)}
                </strong>
              </div>
            </div>

            <div className="hud-panel systems-panel">
              <div className="panel-title">SECURITY / COMMISSIONING GATES</div>
              {snapshot.systems.map((system) => (
                <div className="system-row" key={system.label}>
                  <div>
                    <span>{system.label}</span>
                    <strong>{system.value}</strong>
                  </div>
                  <span className={statusClass(system.state)}>{system.state}</span>
                </div>
              ))}
            </div>

            <div className="hud-panel reminder-panel">
              <div className="panel-title">REMINDER CONTACTS</div>
              {snapshot.reminders.length === 0 ? (
                <div className="console-empty">No reminder contacts.</div>
              ) : (
                snapshot.reminders.slice(0, 5).map((reminder) => (
                  <div className="reminder-row interactive-row" key={reminder.id}>
                    <div className="row-copy">
                      <strong>{reminder.title}</strong>
                      <small>{formatDue(reminder)}</small>
                    </div>
                    <button type="button" disabled={busy} onClick={() => dismissReminder(reminder)}>
                      REMOVE
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="hud-panel note-panel">
              <div className="panel-title">NOTES LOG</div>
              {snapshot.notes.length === 0 ? (
                <div className="console-empty">No notes logged.</div>
              ) : (
                snapshot.notes.slice(0, 5).map((note) => (
                  <div className="note-row interactive-row" key={note.id}>
                    <div className="row-copy">
                      <strong>{note.title}</strong>
                      <small>{note.domain.toUpperCase()}</small>
                    </div>
                    <button type="button" disabled={busy} onClick={() => dismissNote(note)}>
                      REMOVE
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="hud-panel governed-action-panel">
              <div className="panel-title">GOVERNED ACTIONS</div>
              {snapshot.governedActions.length === 0 ? (
                <div className="console-empty">No governed actions proposed.</div>
              ) : (
                snapshot.governedActions.slice(0, 5).map((action) => (
                  <div className="governed-action-row" key={action.id}>
                    <div className="row-copy">
                      <strong>{`${action.tool}.${action.operation}`}</strong>
                      <small>{formatGovernedActionStatus(action)}</small>
                    </div>
                    <span className={statusClass(action.destructive ? "guarded" : "good")}>
                      {action.requiredAuthority}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="hud-panel development-mission-panel">
              <div className="panel-title">DEVELOPMENT MISSIONS</div>
              {snapshot.developmentMissions.length === 0 ? (
                <div className="console-empty">No Development missions tracked.</div>
              ) : (
                snapshot.developmentMissions.slice(0, 5).map((mission) => (
                  <div className="development-mission-row" key={mission.id}>
                    <div className="row-copy">
                      <strong>{mission.repository ?? mission.id}</strong>
                      <small>{mission.branch ?? "no branch bound yet"}</small>
                    </div>
                    <span className={developmentMissionStatusClass(mission)}>{mission.state}</span>
                  </div>
                ))
              )}
            </div>

            <div className="hud-panel activity-panel">
              <div className="panel-title">LIVE ACTIVITY</div>
              {snapshot.activity.slice(0, 6).map((item, index) => (
                <div className="activity-row" key={`${item}-${index}`}>
                  <span className="activity-dot" />
                  <div>
                    <strong>{item}</strong>
                    <small>EVENT {String(index + 1).padStart(2, "0")}</small>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </section>

        <section className="command-deck">
          <form className="capture-card" onSubmit={submitTask}>
            <div>
              <span>TASK CAPTURE</span>
              <strong>Durable Convex task</strong>
            </div>
            <input
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="Task title"
            />
            <select
              value={taskCategory}
              onChange={(event) =>
                setTaskCategory(
                  event.target.value as "personal" | "work" | "builds" | "money" | "life",
                )
              }
            >
              <option value="personal">Personal</option>
              <option value="work">Work</option>
              <option value="builds">Builds</option>
              <option value="money">Money</option>
              <option value="life">Life</option>
            </select>
            <button type="submit" disabled={busy || !taskTitle.trim()}>
              {creatingTask ? "ADDING" : "ADD TASK"}
            </button>
          </form>

          <form className="capture-card" onSubmit={submitReminder}>
            <div>
              <span>REMINDER CAPTURE</span>
              <strong>Durable Convex reminder</strong>
            </div>
            <input
              value={reminderTitle}
              onChange={(event) => setReminderTitle(event.target.value)}
              placeholder="Reminder title"
            />
            <input
              value={reminderDue}
              onChange={(event) => setReminderDue(event.target.value)}
              placeholder="When — exact text preserved"
            />
            <button type="submit" disabled={busy || !reminderTitle.trim()}>
              {creatingReminder ? "SETTING" : "SET REMINDER"}
            </button>
          </form>

          <form className="capture-card" onSubmit={submitNote}>
            <div>
              <span>NOTE CAPTURE</span>
              <strong>Durable Convex note</strong>
            </div>
            <input
              value={noteTitle}
              onChange={(event) => setNoteTitle(event.target.value)}
              placeholder="Note title"
            />
            <input
              value={noteBody}
              onChange={(event) => setNoteBody(event.target.value)}
              placeholder="Note body"
            />
            <button type="submit" disabled={busy || !noteTitle.trim() || !noteBody.trim()}>
              {creatingNote ? "LOGGING" : "LOG NOTE"}
            </button>
          </form>

          <div className="capture-card completion-card">
            <div>
              <span>COMPLETION ARCHIVE</span>
              <strong>
                {formatPartialCount(completedTasks.length, snapshot.counts.tasksPartial)} cleared
                tasks
              </strong>
            </div>
            <div className="completion-list">
              {completedTasks.slice(0, 4).map((task) => (
                <span key={task.id}>{task.title}</span>
              ))}
              {completedTasks.length === 0 && <span>Nothing cleared yet.</span>}
            </div>
          </div>
        </section>

        <footer className="console-footer">
          <span>JARVIS PRIME OMNI · CONSOLE 01</span>
          <span>PHASES 1–3 · AUTHENTICATED CONVEX BRIDGE</span>
        </footer>
      </main>
    </AppsSDKUIProvider>
  );
};

export default JarvisConsole;
