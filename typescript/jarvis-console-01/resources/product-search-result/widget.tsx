import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Expand, PictureInPicture } from "@openai/apps-sdk-ui/components/Icon";
import {
  McpUseProvider,
  useCallTool,
  useWidget,
  type WidgetMetadata,
} from "mcp-use/react";
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import "../styles.css";
import "../phase23.css";
import type {
  JarvisConsoleProps,
  JarvisReminder,
  JarvisTask,
} from "./types";
import { formatPartialCount, taskProgressLabel } from "../../pagination.js";
import { propSchema } from "./types";

export const widgetMetadata: WidgetMetadata = {
  description: "Jarvis Console 01 live command centre HUD",
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoking: "Synchronising Console 01...",
    invoked: "Console 01 online",
  },
};

const statusClass = (state: "good" | "guarded" | "pending") =>
  `status-chip status-${state}`;

function formatDue(reminder: JarvisReminder) {
  if (reminder.dueAt) return new Date(reminder.dueAt).toLocaleString("en-AU");
  return reminder.dueRaw || "No due time";
}

const JarvisConsole: React.FC = () => {
  const {
    props,
    isPending,
    displayMode,
    requestDisplayMode,
    sendFollowUpMessage,
  } = useWidget<JarvisConsoleProps>();
  const { callTool: refreshConsole, isPending: refreshing } = useCallTool(
    "show-jarvis-console",
  );
  const { callTool: createTask, isPending: creatingTask } = useCallTool(
    "create-jarvis-task",
  );
  const { callTool: completeTask, isPending: completingTask } = useCallTool(
    "complete-jarvis-task",
  );
  const { callTool: createReminder, isPending: creatingReminder } = useCallTool(
    "create-jarvis-reminder",
  );
  const { callTool: removeReminder, isPending: removingReminder } = useCallTool(
    "remove-jarvis-reminder",
  );

  const [snapshot, setSnapshot] = useState<JarvisConsoleProps | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCategory, setTaskCategory] =
    useState<"personal" | "work" | "builds" | "money" | "life">("work");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [command, setCommand] = useState("");
  const [feedback, setFeedback] = useState("Console controls ready.");

  useEffect(() => {
    // Once isPending is false the widget lifecycle guarantees props is fully
    // populated, even though the hook's static type stays Partial throughout.
    if (!isPending) setSnapshot(props as JarvisConsoleProps);
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
      <McpUseProvider>
        <div className="jarvis-shell jarvis-loading">
          <div className="loading-core" />
          <p>Synchronising Jarvis Console 01...</p>
        </div>
      </McpUseProvider>
    );
  }

  const isExpanded = displayMode === "fullscreen" || displayMode === "pip";
  const currentTask = activeTasks[0];
  const busy =
    refreshing || creatingTask || completingTask || creatingReminder || removingReminder;

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

  const submitCommand = (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = command.trim();
    if (!prompt) return;
    sendFollowUpMessage(
      `Jarvis Console 01 operator note: "${prompt}". Analyse this against the current console ` +
        "snapshot and propose next steps. Console 01 itself exposes no tool beyond show-jarvis-console, " +
        "create-jarvis-task, complete-jarvis-task, create-jarvis-reminder, and remove-jarvis-reminder " +
        "— it has no deploy, infrastructure, or Convex-schema tool of any kind, so treat this as a " +
        "request for analysis and a proposed plan, not an instruction to execute anything outside that set.",
    );
    setFeedback("Note sent to Jarvis for analysis — it cannot execute anything beyond this console's own typed tools.");
    setCommand("");
  };

  return (
    <McpUseProvider>
      <AppsSDKUIProvider linkComponent={Link}>
        <main className="jarvis-shell phase23-shell">
          <header className="console-header">
            <div className="brand-lockup">
              <div className="mascot-mark" aria-hidden="true">
                <span className="mascot-eye left" />
                <span className="mascot-eye right" />
                <span className="mascot-mouth" />
              </div>
              <div>
                <p className="eyebrow">{snapshot.phase}</p>
                <h1>{snapshot.title}</h1>
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
                  <Button color="secondary" pill size="md" uniform variant="outline" onClick={() => requestDisplayMode("pip")} title="Picture in picture">
                    <PictureInPicture />
                  </Button>
                  <Button color="secondary" pill size="md" uniform variant="outline" onClick={() => requestDisplayMode("fullscreen")} title="Fullscreen">
                    <Expand />
                  </Button>
                </>
              ) : (
                <Button color="secondary" pill size="md" variant="outline" onClick={() => requestDisplayMode("inline")}>
                  EXIT
                </Button>
              )}
            </div>
          </header>

          <section className="telemetry-strip phase23-telemetry">
            <div><span>DEPLOYMENT</span><strong>{snapshot.deployment}</strong></div>
            <div><span>ACTIVE TASKS</span><strong>{formatPartialCount(snapshot.counts.active, snapshot.counts.tasksPartial)}</strong></div>
            <div><span>REMINDERS</span><strong>{formatPartialCount(snapshot.counts.reminders, snapshot.counts.remindersPartial)}</strong></div>
            <div><span>LAST SYNC</span><strong>{new Date(snapshot.lastUpdated).toLocaleTimeString("en-AU")}</strong></div>
          </section>

          <section className="console-grid phase23-grid">
            <aside className="left-rail">
              <div className="hud-panel system-core-panel">
                <div className="panel-title">SYSTEM CORE</div>
                <div className="mini-reactor">
                  <div className="mini-ring ring-a" />
                  <div className="mini-ring ring-b" />
                  <div className="mini-core">J</div>
                </div>
                <div className="core-stats">
                  <div><span>ACTIVE</span><strong>{formatPartialCount(snapshot.counts.active, snapshot.counts.tasksPartial)}</strong></div>
                  <div><span>CLEARED</span><strong>{formatPartialCount(snapshot.counts.completed, snapshot.counts.tasksPartial)}</strong></div>
                  <div><span>ALERTS</span><strong>{formatPartialCount(snapshot.counts.reminders, snapshot.counts.remindersPartial)}</strong></div>
                </div>
              </div>

              <div className="hud-panel task-stack live-task-stack">
                <div className="panel-title">ACTIVE MISSION STACK</div>
                {activeTasks.length === 0 ? (
                  <div className="console-empty">Command deck clear.</div>
                ) : (
                  activeTasks.slice(0, 6).map((task, index) => (
                    <div className="task-row task-active interactive-row" key={task.id}>
                      <span className="task-index">{String(index + 1).padStart(2, "0")}</span>
                      <div className="row-copy"><strong>{task.title}</strong><small>{task.category.toUpperCase()}</small></div>
                      <button type="button" disabled={busy} onClick={() => clearTask(task)}>CLEAR</button>
                    </div>
                  ))
                )}
              </div>
            </aside>

            <section className="centre-stage phase23-centre">
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
                <div className="reactor-progress" style={{ "--progress": `${snapshot.progress}%` } as React.CSSProperties} />
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
                  <input id="operator-command-input" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Ask Jarvis to inspect, plan or propose the next safe action" />
                  <button type="submit">ROUTE</button>
                </div>
              </form>

              <div className="feedback-strip">{feedback}</div>
            </section>

            <aside className="right-rail">
              <div className="hud-panel systems-panel">
                <div className="panel-title">SYSTEM MATRIX</div>
                {snapshot.systems.map((system) => (
                  <div className="system-row" key={system.label}>
                    <div><span>{system.label}</span><strong>{system.value}</strong></div>
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
                      <div className="row-copy"><strong>{reminder.title}</strong><small>{formatDue(reminder)}</small></div>
                      <button type="button" disabled={busy} onClick={() => dismissReminder(reminder)}>REMOVE</button>
                    </div>
                  ))
                )}
              </div>

              <div className="hud-panel activity-panel">
                <div className="panel-title">LIVE ACTIVITY</div>
                {snapshot.activity.slice(0, 6).map((item, index) => (
                  <div className="activity-row" key={`${item}-${index}`}>
                    <span className="activity-dot" />
                    <div><strong>{item}</strong><small>EVENT {String(index + 1).padStart(2, "0")}</small></div>
                  </div>
                ))}
              </div>
            </aside>
          </section>

          <section className="command-deck">
            <form className="capture-card" onSubmit={submitTask}>
              <div><span>TASK CAPTURE</span><strong>Durable Convex task</strong></div>
              <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Task title" />
              <select
                value={taskCategory}
                onChange={(event) =>
                  setTaskCategory(
                    event.target.value as "personal" | "work" | "builds" | "money" | "life",
                  )
                }
              >
                <option value="personal">Personal</option><option value="work">Work</option><option value="builds">Builds</option><option value="money">Money</option><option value="life">Life</option>
              </select>
              <button type="submit" disabled={busy || !taskTitle.trim()}>{creatingTask ? "ADDING" : "ADD TASK"}</button>
            </form>

            <form className="capture-card" onSubmit={submitReminder}>
              <div><span>REMINDER CAPTURE</span><strong>Durable Convex reminder</strong></div>
              <input value={reminderTitle} onChange={(event) => setReminderTitle(event.target.value)} placeholder="Reminder title" />
              <input value={reminderDue} onChange={(event) => setReminderDue(event.target.value)} placeholder="When — exact text preserved" />
              <button type="submit" disabled={busy || !reminderTitle.trim()}>{creatingReminder ? "SETTING" : "SET REMINDER"}</button>
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
                {completedTasks.slice(0, 4).map((task) => <span key={task.id}>{task.title}</span>)}
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
    </McpUseProvider>
  );
};

export default JarvisConsole;
