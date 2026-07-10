import { createPersistenceFromEnv, PersistenceProvider, AssistantState } from "./persistence/persistence.js";

export type CLIDeps = {
  persistence?: PersistenceProvider;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  exit?: (code: number) => void;
};

class RuntimeState {
  private state: AssistantState = {};

  load(initial: AssistantState) {
    this.state = { ...initial };
  }

  snapshot(): AssistantState {
    return { ...this.state };
  }

  setLastIntent(intent: string) {
    this.state.lastIntent = intent;
  }

  setLastInput(input: string) {
    this.state.lastInput = input;
  }

  setLastResult(result: unknown) {
    this.state.lastResult = result;
  }

  setLastReminder(reminder: unknown) {
    this.state.lastReminder = reminder;
  }

  setLastTask(task: unknown) {
    this.state.lastTask = task;
  }

  addNote(text: string) {
    const notes = (this.state.notes as string[]) ?? [];
    notes.push(text);
    this.state.notes = notes;
  }

  addReminder(r: { id?: string; title: string; due?: string }) {
    const rs = (this.state.reminders as any[]) ?? [];
    rs.push(r);
    this.state.reminders = rs;
    this.setLastReminder(r);
  }

  addTask(t: { id?: string; title: string; completed?: boolean }) {
    const ts = (this.state.tasks as any[]) ?? [];
    ts.push(t);
    this.state.tasks = ts;
    this.setLastTask(t);
  }
}

export async function runCli(argv: string[], deps: CLIDeps = {}) {
  const stdout = deps.stdout ?? ((s: string) => console.log(s));
  const stderr = deps.stderr ?? ((s: string) => console.error(s));
  const exit = deps.exit ?? ((c: number) => { if (c !== 0) process.exit(c); });

  // Create a single persistence provider for the lifetime of the CLI.
  const persistence: PersistenceProvider = deps.persistence ?? createPersistenceFromEnv();

  // Load startup state once.
  let initialState: AssistantState;
  try {
    initialState = await persistence.loadState();
  } catch (err: unknown) {
    stderr(`Failed to load persistent state: ${(err as Error).message}`);
    exit(1);
    return;
  }

  const runtime = new RuntimeState();
  runtime.load(initialState ?? {});

  // helper to persist the current runtime snapshot plus any extras
  async function saveRuntimeState(extra: AssistantState = {}) {
    const toSave: AssistantState = { ...runtime.snapshot(), ...extra };
    try {
      await persistence.saveState(toSave);
    } catch (err: unknown) {
      stderr(`Failed to save persistent state: ${(err as Error).message}`);
      throw err;
    }
  }

  const args = argv.slice();
  const cmd = args.shift();

  if (!cmd) {
    stdout("No command provided. Use: status|checklist|note|notes|add-reminder|list-reminders|add-task|list-tasks");
    return;
  }

  if (cmd === "status") {
    runtime.setLastIntent("status");
    runtime.setLastInput("");
    runtime.setLastResult({ ok: true });
    await saveRuntimeState();
    stdout("Jarvis is working.");
    return;
  }

  if (cmd === "checklist") {
    runtime.setLastIntent("checklist");
    runtime.setLastInput("");
    runtime.setLastResult({ printed: true });
    const lines = [
      "Jarvis daily checklist:",
      "1. Check calendar and booked jobs.",
      "2. Confirm client messages and invoice follow-ups.",
      "3. Load tools, PPE, fuel, batteries, and consumables.",
      "4. Check job scope, access, waste volume, and weather.",
      "5. Photograph before/during/after where useful.",
      "6. Record labour, materials, waste, travel, and extras before leaving site.",
      "7. Send quote/invoice/follow-up before the day gets away from you.",
    ];
    stdout(lines.join("\n"));
    await saveRuntimeState();
    return;
  }

  if (cmd === "note") {
    const text = args.join(" ").trim();
    if (!text) {
      stderr("Error: Note text cannot be empty.");
      exit(2);
      return;
    }
    runtime.setLastIntent("note");
    runtime.setLastInput(text);
    runtime.addNote(text);
    runtime.setLastResult({ saved: true, text });
    try {
      await saveRuntimeState();
    } catch (err) {
      // saveRuntimeState already reported the error
      exit(1);
      return;
    }
    stdout(`Saved note: ${text}`);
    return;
  }

  if (cmd === "notes") {
    const notes = (runtime.snapshot().notes as string[]) ?? [];
    if (notes.length === 0) {
      stdout("No notes saved yet.");
      return;
    }
    notes.forEach((n, idx) => stdout(`${idx + 1}. ${n}`));
    runtime.setLastIntent("notes");
    runtime.setLastResult({ count: notes.length });
    await saveRuntimeState();
    return;
  }

  if (cmd === "add-reminder") {
    const title = args.join(" ").trim();
    if (!title) {
      stderr("Error: reminder title cannot be empty.");
      exit(2);
      return;
    }
    const reminder = { title, id: undefined };
    runtime.setLastIntent("add-reminder");
    runtime.setLastInput(title);
    runtime.addReminder(reminder);
    runtime.setLastResult({ saved: true, reminder });
    try {
      await saveRuntimeState();
    } catch (err) {
      exit(1);
      return;
    }
    stdout(`Saved reminder: ${title}`);
    return;
  }

  if (cmd === "list-reminders") {
    const reminders = (runtime.snapshot().reminders as any[]) ?? [];
    if (reminders.length === 0) {
      stdout("No reminders saved yet.");
      return;
    }
    reminders.forEach((r, idx) => stdout(`${idx + 1}. ${r.title}`));
    runtime.setLastIntent("list-reminders");
    runtime.setLastResult({ count: reminders.length });
    await saveRuntimeState();
    return;
  }

  if (cmd === "add-task") {
    const title = args.join(" ").trim();
    if (!title) {
      stderr("Error: task title cannot be empty.");
      exit(2);
      return;
    }
    const task = { title, completed: false };
    runtime.setLastIntent("add-task");
    runtime.setLastInput(title);
    runtime.addTask(task);
    runtime.setLastResult({ saved: true, task });
    try {
      await saveRuntimeState();
    } catch (err) {
      exit(1);
      return;
    }
    stdout(`Saved task: ${title}`);
    return;
  }

  if (cmd === "list-tasks") {
    const tasks = (runtime.snapshot().tasks as any[]) ?? [];
    if (tasks.length === 0) {
      stdout("No tasks saved yet.");
      return;
    }
    tasks.forEach((t, idx) => stdout(`${idx + 1}. ${t.title} ${t.completed ? "(done)" : ""}`));
    runtime.setLastIntent("list-tasks");
    runtime.setLastResult({ count: tasks.length });
    await saveRuntimeState();
    return;
  }

  stderr(`Unknown command: ${cmd}`);
}

export default runCli;
