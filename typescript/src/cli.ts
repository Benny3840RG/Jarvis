import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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
  type Task,
} from "./persistence/persistence.js";

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
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printTaskList(write: ConsoleWriter, tasks: ReturnType<TaskService["list"]>): void {
  if (tasks.length === 0) {
    write("Jarvis: No tasks saved.");
    return;
  }
  for (const task of tasks) {
    write(`${task.completed ? "[x]" : "[ ]"} ${task.id} ${task.title}`);
  }
}

function printReminderList(write: ConsoleWriter, reminders: ReturnType<ReminderService["list"]>): void {
  if (reminders.length === 0) {
    write("Jarvis: No reminders saved.");
    return;
  }
  for (const reminder of reminders) {
    write(
      `${reminder.id} ${reminder.title}${reminder.dueRaw ? ` — ${reminder.dueRaw}` : ""}`,
    );
  }
}

export async function runCli(deps: RunCliDependencies = {}): Promise<void> {
  const write = deps.stdout ?? ((...values: unknown[]) => console.log(...values));
  const writeError = deps.stderr ?? ((...values: unknown[]) => console.error(...values));
  const rl = deps.readline ?? (readlinePromises.createInterface({ input, output }) as ReadlineAdapter);
  const persistence = deps.persistence ?? createPersistenceFromEnv();

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
          "2026-07-11",
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

  write("Jarvis CLI ready. Type 'exit' to quit.");

  try {
    while (true) {
      const inputText = await rl.question("You: ");
      const trimmed = inputText.trim();
      const lower = trimmed.toLowerCase();
      if (lower === "exit") break;

      try {
        const taskAdd = /^task add\s+(.+)$/i.exec(trimmed);
        const taskComplete = /^task complete\s+(.+)$/i.exec(trimmed);
        const taskRemove = /^task remove\s+(.+)$/i.exec(trimmed);
        const reminderAdd = /^reminder add\s+(.+?)\s+--due\s+(.+)$/i.exec(trimmed);
        const reminderRemove = /^reminder remove\s+(.+)$/i.exec(trimmed);

        if (taskAdd) {
          const task = await persistence.addTask(taskAdd[1].trim(), "personal");
          taskService.replace([...taskService.list(), task]);
          await saveRuntimeState({ lastInput: inputText, lastIntent: "task-add", lastTask: task });
          write("Jarvis:", `Task added: ${task.title}`);
          continue;
        }

        if (lower === "task list") {
          printTaskList(write, await refreshTasks());
          continue;
        }

        if (taskComplete) {
          const task = await persistence.completeTask(taskComplete[1].trim());
          if (!task) {
            write("Jarvis: Task not found.");
            continue;
          }
          taskService.replace(
            taskService.list().map((entry) => (entry.id === task.id ? task : entry)),
          );
          await saveRuntimeState({ lastInput: inputText, lastIntent: "task-complete", lastTask: task });
          write("Jarvis:", `Task completed: ${task.title}`);
          continue;
        }

        if (taskRemove) {
          const task = await persistence.removeTask(taskRemove[1].trim());
          if (!task) {
            write("Jarvis: Task not found.");
            continue;
          }
          taskService.replace(taskService.list().filter((entry) => entry.id !== task.id));
          await saveRuntimeState({ lastInput: inputText, lastIntent: "task-remove", lastTask: task });
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

        if (reminderRemove) {
          const reminder = await persistence.removeReminder(reminderRemove[1].trim());
          if (!reminder) {
            write("Jarvis: Reminder not found.");
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
            "Jarvis: Use `task add <title>`, `task list`, `task complete <id>`, or `task remove <id>`.",
          );
          continue;
        }

        if (lower.includes("remind")) {
          write(
            "Jarvis: Use `reminder add <title> --due <when>`, `reminder list`, or `reminder remove <id>`.",
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
          await saveRuntimeState({ lastInput: inputText, lastIntent: intent, lastResult: result });
          write("Jarvis:", `${reply}\nWorkflow: ${JSON.stringify(workflow)}`);
          write(
            JSON.stringify({ intent, result, workflow, suggestion: learningEngine.suggest() }, null, 2),
          );
        } else {
          await saveRuntimeState({ lastInput: inputText, lastIntent: intent, lastResult: result });
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
