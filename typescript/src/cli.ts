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
import {
  createPersistenceFromEnv,
  type AssistantState,
  type PersistenceProvider,
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
  try {
    previousState = await persistence.loadState();
  } catch (error: unknown) {
    rl.close();
    writeError("Failed to load persistent state:", errorMessage(error));
    throw error;
  }

  for (const [key, value] of Object.entries(previousState)) state.set(key, value);

  const workshop = new WorkshopEngine();
  const business = new BusinessEngine();
  const home = new HomeEngine();
  const workflowGenerator = new WorkflowGenerator();
  const learningEngine = new LearningEngine();
  const reminderService = new ReminderService();
  const taskService = new TaskService();
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
  ]) graph.addNode(node);
  for (const edge of [
    { from: "workshop", to: "safety" },
    { from: "business", to: "safety" },
    { from: "home", to: "safety" },
  ]) graph.addEdge(edge);

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

  async function saveRuntimeState(extra: AssistantState = {}): Promise<void> {
    try {
      await persistence.saveState({ ...state.snapshot(), ...extra });
    } catch (error: unknown) {
      writeError("Failed to save persistent state:", errorMessage(error));
      throw error;
    }
  }

  write("Jarvis CLI ready. Type 'exit' to quit.");

  try {
    while (true) {
      const inputText = await rl.question("You: ");
      const lower = inputText.trim().toLowerCase();
      if (lower === "exit") break;

      const parsed = conversation.parse(inputText, {});
      const intent = router.route(inputText);
      contextMemory.remember(inputText);
      const plan = orchestrator.plan(parsed);
      const result = await orchestrator.execute(plan);
      const reply = responseFormatter.format(intent, inputText);

      if (lower.includes("remind")) {
        const reminder = reminderService.add(inputText, "tomorrow");
        await saveRuntimeState({ lastInput: inputText, lastIntent: intent, lastReminder: reminder });
        write("Jarvis:", `Reminder set: ${reminder.title} for ${reminder.due}`);
        write(JSON.stringify({ intent, reminder }, null, 2));
      } else if (lower.includes("task") && !lower.includes("plan")) {
        const task = taskService.add(inputText, "personal");
        await saveRuntimeState({ lastInput: inputText, lastIntent: intent, lastTask: task });
        write("Jarvis:", `Task added: ${task.title}`);
        write(JSON.stringify({ intent, task }, null, 2));
      } else if (lower.includes("summary")) {
        const summary = proactiveAssistant.summarize(taskService.list());
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
        write(JSON.stringify({ intent, result, workflow, suggestion: learningEngine.suggest() }, null, 2));
      } else {
        await saveRuntimeState({ lastInput: inputText, lastIntent: intent, lastResult: result });
        write("Jarvis:", reply);
        write(JSON.stringify({ intent, result }, null, 2));
      }
    }
  } finally {
    rl.close();
  }
}

export default runCli;
