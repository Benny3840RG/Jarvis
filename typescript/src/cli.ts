import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { parseUpdateOptions } from "./cli/updateOptions.js";
import { ConversationService } from "./runtime/conversationService.js";
import { MemoryService } from "./runtime/memoryService.js";
import { StateService } from "./runtime/stateService.js";
import { IntentRouter } from "./runtime/intentRouter.js";
import { AssistantResponse } from "./runtime/assistantResponse.js";
import { WorkshopEngine } from "./domains/workshopEngine.js";
import { BusinessEngine } from "./domains/businessEngine.js";
import { HomeEngine } from "./domains/homeEngine.js";
import { SafetyEnvelope } from "./safety/safetyEnvelope.js";
import { OrchestrationGraph } from "./orchestration/graph.js";
import { Orchestrator } from "./runtime/orchestrator.js";
import { WorkflowGenerator } from "./autonomy/workflowGenerator.js";
import { LearningEngine } from "./adaptive/learningEngine.js";
import { ReminderService } from "./runtime/reminderService.js";
import { TaskService } from "./runtime/taskService.js";
import { ProactiveAssistant } from "./runtime/proactiveAssistant.js";
import { ContextMemory } from "./runtime/contextMemory.js";
import { PersonalTraitsService } from "./runtime/personalTraitsService.js";
import { parseReminderDue } from "./reminders/due.js";
import {
  createPersistenceFromEnv,
  type AssistantState,
  type PersistenceProvider,
  type Reminder,
  type ReminderUpdate,
  type Task,
  type TaskUpdate,
} from "./persistence/persistence.js";
import { resolvePersistenceProviderName } from "./persistence/providerSelection.js";

export interface ReadlineAdapter {
  question(prompt: string): Promise<string>;
  close(): void;
}

export type ConsoleWriter = (...values: unknown[]) => void;

export type RunCliDependencies = {
  persistence?: PersistenceProvider;
  readline?: ReadlineAdapter;
  stdout?: ConsoleWriter;
  stderr?: ConsoleWriter;
  providerName?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function upsertById<T extends { id: string }>(records: readonly T[], record: T): T[] {
  const index = records.findIndex((entry) => entry.id === record.id);
  if (index < 0) return [...records, record];
  return records.map((entry, entryIndex) => (entryIndex === index ? record : entry));
}

export function compactId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function resolveId(alias: string, records: readonly { id: string }[], kind: string): string {
  if (records.some((r) => r.id === alias)) return alias;
  const prefix = records.filter((r) => r.id.startsWith(alias));
  if (prefix.length === 1) return prefix[0].id;
  if (prefix.length > 1)
    throw new Error(
      `Ambiguous ${kind} ID "${alias}" — ${prefix.length} records share that prefix. Use a longer prefix or the full ID.`,
    );
  return alias;
}

function printTaskList(write: ConsoleWriter, tasks: ReturnType<TaskService["list"]>): void {
  if (tasks.length === 0) {
    write("Jarvis: No tasks saved.");
    return;
  }
  for (const task of tasks) {
    write(
      `${task.completed ? "[x]" : "[ ]"} ${compactId(task.id)} ${task.title} [${task.category}]`,
    );
  }
}

function printReminderList(
  write: ConsoleWriter,
  reminders: ReturnType<ReminderService["list"]>,
): void {
  if (reminders.length === 0) {
    write("Jarvis: No reminders saved.");
    return;
  }
  for (const reminder of reminders) {
    write(
      `${compactId(reminder.id)} ${reminder.title}${reminder.dueRaw ? ` — ${reminder.dueRaw}` : ""}`,
    );
  }
}

function taskUpdateFromOptions(input: string | undefined): TaskUpdate {
  const options = parseUpdateOptions(input, ["title", "category"]);
  return {
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.category === "string" ? { category: options.category } : {}),
  };
}

function reminderUpdateFromOptions(input: string | undefined): ReminderUpdate {
  const options = parseUpdateOptions(input, ["title", "due"], ["clear-due"]);
  if (options.due !== undefined && options["clear-due"] === true) {
    throw new Error("Reminder update cannot use --due and --clear-due together.");
  }
  return {
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.due === "string"
      ? { due: parseReminderDue(options.due) }
      : options["clear-due"] === true
        ? { due: null }
        : {}),
  };
}

export async function runCli(deps: RunCliDependencies = {}): Promise<void> {
  const write = deps.stdout ?? ((...values: unknown[]) => console.log(...values));
  const writeError = deps.stderr ?? ((...values: unknown[]) => console.error(...values));
  const rl =
    deps.readline ?? (readlinePromises.createInterface({ input, output }) as ReadlineAdapter);
  const persistence = deps.persistence ?? createPersistenceFromEnv();
  const providerLabel = deps.providerName ?? resolvePersistenceProviderName();

  const conversation = new ConversationService();
  const memory = new MemoryService();
  const router = new IntentRouter();
  const responseFormatter = new AssistantResponse();
  const state = new StateService();

  let previousState: AssistantState;
  let restoredTasks: Task[];
  let restoredReminders: Reminder[];
  try {
    [previousState, restoredTasks, restoredReminders] = await Promise.all([
      persistence.loadState(),
      persistence.listTasks(),
      persistence.listReminders(),
    ]);
  } catch (error: unknown) {
    rl.close();
    writeError("Failed to load persistent data:", errorMessage(error));
    throw error;
  }

  for (const [key, value] of Object.entries(previousState)) state.set(key, value);

  const workshop = new WorkshopEngine();
  const business = new BusinessEngine();
  const home = new HomeEngine();
  const workflowGenerator = new WorkflowGenerator();
  const learningEngine = new LearningEngine();
  const reminderService = new ReminderService(restoredReminders);
  const taskService = new TaskService(restoredTasks);
  const proactiveAssistant = new ProactiveAssistant();
  const contextMemory = new ContextMemory();
  const personalTraits = new PersonalTraitsService();
  const safety = new SafetyEnvelope();
  const graph = new OrchestrationGraph();

  for (const node of [
    { id: "workshop", kind: "domain" },
    { id: "business", kind: "domain" },
    { id: "home", kind: "domain" },
    { id: "safety", kind: "safety" },
  ])
    graph.addNode(node);
  for (const edge of [
    { from: "workshop", to: "safety" },
    { from: "business", to: "safety" },
    { from: "home", to: "safety" },
  ])
    graph.addEdge(edge);

  const domainRouter = {
    async route(module: string, action: string, payload: unknown): Promise<unknown> {
      if (module === "domains" && action === "plan") {
        const workshopTask = workshop.createTask(
          "Prototype Jarvis",
          "Create the first workshop task",
          "high",
        );
        const businessTask = business.createTask(
          "Submit build update",
          "Share the current Jarvis progress",
        );
        const homeTask = home.createTask(
          "Reset living room",
          "Tidy up the living room",
          "living room",
        );
        state.set("lastIntent", String(payload));
        return {
          module,
          action,
          payload,
          workshopTask,
          workshopSummary: workshop.summarize(workshopTask),
          businessTask,
          businessSummary: business.summarize(businessTask),
          homeTask,
          homeSummary: home.summarize(homeTask),
          graph: graph.getPlan(),
          state: state.snapshot(),
        };
      }
      return { module, action, payload };
    },
  };

  const orchestrator = new Orchestrator(memory, domainRouter, safety);

  async function saveRuntimeState(extra: AssistantState = {}): Promise<boolean> {
    for (const [key, value] of Object.entries(extra)) state.set(key, value);
    try {
      await persistence.saveState(state.snapshot());
      return true;
    } catch (error: unknown) {
      writeError("Failed to save runtime state:", errorMessage(error));
      return false;
    }
  }

  async function refreshTasks(): Promise<Task[]> {
    const tasks = await persistence.listTasks();
    taskService.replace(tasks);
    return taskService.list();
  }

  async function refreshReminders(): Promise<Reminder[]> {
    const reminders = await persistence.listReminders();
    reminderService.replace(reminders);
    return reminderService.list();
  }

  write(
    `Jarvis CLI ready (provider: ${providerLabel}). Type 'help' for commands or 'exit' to quit.`,
  );

  try {
    while (true) {
      const inputText = await rl.question("You: ");
      const trimmed = inputText.trim();
      const lower = trimmed.toLowerCase();
      if (lower === "exit") break;

      try {
        if (lower === "help") {
          write(
            [
              "Jarvis: Available commands:",
              "  task add <title>",
              "  task list",
              "  task update <id> [--title <title>] [--category <category>]",
              "  task complete <id>",
              "  task remove <id>",
              "  reminder add <title> --due <when>",
              "  reminder list",
              "  reminder update <id> [--title <title>] [--due <when> | --clear-due]",
              "  reminder remove <id>",
              "  help",
              "  exit",
              "",
              "IDs shown in listings are abbreviated. Use the abbreviated form or any unambiguous prefix as <id>.",
            ].join("\n"),
          );
          continue;
        }

        const taskAdd = /^task add\s+(.+)$/i.exec(trimmed);
        const taskUpdate = /^task update\s+(\S+)(?:\s+(.*))?$/i.exec(trimmed);
        const taskComplete = /^task complete\s+(.+)$/i.exec(trimmed);
        const taskRemove = /^task remove\s+(.+)$/i.exec(trimmed);
        const reminderAdd = /^reminder add\s+(.+?)\s+--due\s+(.+)$/i.exec(trimmed);
        const reminderUpdate = /^reminder update\s+(\S+)(?:\s+(.*))?$/i.exec(trimmed);
        const reminderRemove = /^reminder remove\s+(.+)$/i.exec(trimmed);

        if (taskAdd) {
          const task = await persistence.addTask(taskAdd[1].trim(), "personal");
          taskService.replace([...taskService.list(), task]);
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "task-add",
            lastTask: task,
          });
          write("Jarvis:", `Task added: ${task.title}`);
          continue;
        }

        if (lower === "task list") {
          printTaskList(write, await refreshTasks());
          continue;
        }

        if (taskUpdate) {
          const id = resolveId(taskUpdate[1].trim(), taskService.list(), "task");
          const task = await persistence.updateTask(id, taskUpdateFromOptions(taskUpdate[2]));
          if (!task) {
            write("Jarvis: Task not found. Use `task list` to see current IDs.");
            continue;
          }
          taskService.replace(upsertById(taskService.list(), task));
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "task-update",
            lastTask: task,
          });
          write("Jarvis:", `Task updated: ${task.title} [${task.category}]`);
          continue;
        }

        if (taskComplete) {
          const id = resolveId(taskComplete[1].trim(), taskService.list(), "task");
          const task = await persistence.completeTask(id);
          if (!task) {
            write("Jarvis: Task not found. Use `task list` to see current IDs.");
            continue;
          }
          taskService.replace(upsertById(taskService.list(), task));
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "task-complete",
            lastTask: task,
          });
          write("Jarvis:", `Task completed: ${task.title}`);
          continue;
        }

        if (taskRemove) {
          const id = resolveId(taskRemove[1].trim(), taskService.list(), "task");
          const task = await persistence.removeTask(id);
          if (!task) {
            write("Jarvis: Task not found. Use `task list` to see current IDs.");
            continue;
          }
          taskService.replace(taskService.list().filter((entry) => entry.id !== task.id));
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "task-remove",
            lastTask: task,
          });
          write("Jarvis:", `Task removed: ${task.title}`);
          continue;
        }

        if (reminderAdd) {
          const due = parseReminderDue(reminderAdd[2]);
          const reminder = await persistence.addReminder(reminderAdd[1].trim(), due);
          reminderService.replace([...reminderService.list(), reminder]);
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "reminder-add",
            lastReminder: reminder,
          });
          write("Jarvis:", `Reminder set: ${reminder.title} for ${reminder.dueRaw}`);
          continue;
        }

        if (lower === "reminder list") {
          printReminderList(write, await refreshReminders());
          continue;
        }

        if (reminderUpdate) {
          const id = resolveId(reminderUpdate[1].trim(), reminderService.list(), "reminder");
          const reminder = await persistence.updateReminder(
            id,
            reminderUpdateFromOptions(reminderUpdate[2]),
          );
          if (!reminder) {
            write("Jarvis: Reminder not found. Use `reminder list` to see current IDs.");
            continue;
          }
          reminderService.replace(upsertById(reminderService.list(), reminder));
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "reminder-update",
            lastReminder: reminder,
          });
          write(
            "Jarvis:",
            `Reminder updated: ${reminder.title}${reminder.dueRaw ? ` for ${reminder.dueRaw}` : ""}`,
          );
          continue;
        }

        if (reminderRemove) {
          const id = resolveId(reminderRemove[1].trim(), reminderService.list(), "reminder");
          const reminder = await persistence.removeReminder(id);
          if (!reminder) {
            write("Jarvis: Reminder not found. Use `reminder list` to see current IDs.");
            continue;
          }
          reminderService.replace(
            reminderService.list().filter((entry) => entry.id !== reminder.id),
          );
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: "reminder-remove",
            lastReminder: reminder,
          });
          write("Jarvis:", `Reminder removed: ${reminder.title}`);
          continue;
        }

        if (lower.includes("task") && !lower.includes("plan")) {
          write(
            "Jarvis: Use `task add <title>`, `task list`, `task update <id> [--title <title>] [--category <category>]`, `task complete <id>`, or `task remove <id>`. IDs are shown in `task list`; use the abbreviated form or any unambiguous prefix.",
          );
          continue;
        }

        if (lower.includes("remind")) {
          write(
            "Jarvis: Use `reminder add <title> --due <when>`, `reminder list`, `reminder update <id> [--title <title>] [--due <when> | --clear-due]`, or `reminder remove <id>`. IDs are shown in `reminder list`; use the abbreviated form or any unambiguous prefix.",
          );
          continue;
        }

        const parsed = conversation.parse(inputText, {});
        const intent = router.route(inputText);
        contextMemory.remember(inputText);
        const plan = orchestrator.plan(parsed);
        const result = await orchestrator.execute(plan);
        const reply = responseFormatter.format(intent, inputText);

        if (lower.includes("summary")) {
          const summary = proactiveAssistant.summarize(await refreshTasks());
          write("Jarvis:", summary);
          write(JSON.stringify({ intent, summary }, null, 2));
        } else if (lower.includes("remember")) {
          const keyword = lower.replace(/^.*?remember\s+/, "").trim() || "milk";
          const recall = contextMemory.recall(keyword);
          write("Jarvis:", `I remember: ${recall.join(", ") || "nothing yet"}`);
          write(JSON.stringify({ intent, recall }, null, 2));
        } else if (lower.includes("brief")) {
          const brief = personalTraits.dailyBrief();
          write("Jarvis:", brief);
          write(JSON.stringify({ intent, brief }, null, 2));
        } else if (lower.includes("motivate")) {
          const motivation = personalTraits.motivation();
          write("Jarvis:", motivation);
          write(JSON.stringify({ intent, motivation }, null, 2));
        } else if (intent === "planning") {
          const workflow = workflowGenerator.createPlan(inputText, {
            priority: "high",
            context: "workshop, business, and home tasks",
          });
          learningEngine.observe(inputText);
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: intent,
            lastResult: result,
          });
          write("Jarvis:", `${reply}\nWorkflow: ${JSON.stringify(workflow)}`);
          write(
            JSON.stringify(
              {
                intent,
                result,
                workflow,
                suggestion: learningEngine.suggest(),
              },
              null,
              2,
            ),
          );
        } else {
          await saveRuntimeState({
            lastInput: inputText,
            lastIntent: intent,
            lastResult: result,
          });
          write("Jarvis:", reply);
          write(JSON.stringify({ intent, result }, null, 2));
        }
      } catch (error: unknown) {
        writeError("Command failed:", errorMessage(error));
      }
    }
  } finally {
    rl.close();
  }
}

export default runCli;
