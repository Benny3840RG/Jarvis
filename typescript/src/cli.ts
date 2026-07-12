import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ConversationService } from "../dist/runtime/conversationService.js";
import { MemoryService } from "../dist/runtime/memoryService.js";
import { StateService } from "../dist/runtime/stateService.js";
import { IntentRouter } from "../dist/runtime/intentRouter.js";
import { AssistantResponse } from "../dist/runtime/assistantResponse.js";
import { WorkshopEngine } from "../dist/domains/workshopEngine.js";
import { BusinessEngine } from "../dist/domains/businessEngine.js";
import { HomeEngine } from "../dist/domains/homeEngine.js";
import { SafetyEnvelope } from "../dist/safety/safetyEnvelope.js";
import { OrchestrationGraph } from "../dist/orchestration/graph.js";
import { Orchestrator } from "../dist/runtime/orchestrator.js";
import { WorkflowGenerator } from "../dist/autonomy/workflowGenerator.js";
import { LearningEngine } from "../dist/adaptive/learningEngine.js";
import { ReminderService } from "../dist/runtime/reminderService.js";
import { TaskService } from "../dist/runtime/taskService.js";
import { ProactiveAssistant } from "../dist/runtime/proactiveAssistant.js";
import { ContextMemory } from "../dist/runtime/contextMemory.js";
import { PersonalTraitsService } from "../dist/runtime/personalTraitsService.js";

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
  const rl =
    deps.readline ??
    (readlinePromises.createInterface({ input, output }) as ReadlineAdapter);
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

  Object.entries(previousState).forEach(([key, value]) => {
    state.set(key, value);
  });

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

  graph.addNode({ id: "workshop", kind: "domain" });
  graph.addNode({ id: "business", kind: "domain" });
  graph.addNode({ id: "home", kind: "domain" });
  graph.addNode({ id: "safety", kind: "safety" });
  graph.addEdge({ from: "workshop", to: "safety" });
  graph.addEdge({ from: "business", to: "safety" });
  graph.addEdge({ from: "home", to: "safety" });

  const domainRouter = {
    async route(module: string, action: string, payload: unknown) {
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
      await persistence.saveState({
        ...state.snapshot(),
        ...extra,
      });
    } catch (error: unknown) {
      writeError("Failed to save persistent state:", errorMessage(error));
      throw error;
    }
  }

  write("Jarvis CLI ready. Type 'exit' to quit.");

  try {
    while (true) {
      const inputText = await rl.question("You: ");
      if (inputText.trim().toLowerCase() === "exit") {
        break;
      }

      const parsed = conversation.parse(inputText, {});
      const intent = router.route(inputText);
      contextMemory.remember(inputText);
      const plan = orchestrator.plan(parsed);
      const result = await orchestrator.execute(plan);
      const reply = responseFormatter.format(intent, inputText);

      if (intent === "planning") {
        const workflow = workflowGenerator.createPlan(inputText, {
          priority: "high",
          context: "workshop, business, and home tasks",
        });
        learningEngine.observe(inputText);
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
      } else if (inputText.toLowerCase().includes("remind")) {
        const reminder = reminderService.add(inputText, "tomorrow");
        await saveRuntimeState({
          lastInput: inputText,
          lastIntent: intent,
          lastReminder: reminder,
        });
        write("Jarvis:", `Reminder set: ${reminder.title} for ${reminder.due}`);
        write(JSON.stringify({ intent, reminder }, null, 2));
      } else if (inputText.toLowerCase().includes("task")) {
        const task = taskService.add(inputText, "personal");
        await saveRuntimeState({
          lastInput: inputText,
          lastIntent: intent,
          lastTask: task,
        });
        write("Jarvis:", `Task added: ${task.title}`);
        write(JSON.stringify({ intent, task }, null, 2));
      } else if (inputText.toLowerCase().includes("summary")) {
        const summary = proactiveAssistant.summarize(taskService.list());
        write("Jarvis:", summary);
        write(JSON.stringify({ intent, summary }, null, 2));
      } else if (inputText.toLowerCase().includes("remember")) {
        const recall = contextMemory.recall("milk");
        write("Jarvis:", `I remember: ${recall.join(", ") || "nothing yet"}`);
        write(JSON.stringify({ intent, recall }, null, 2));
      } else if (inputText.toLowerCase().includes("brief")) {
        const brief = personalTraits.dailyBrief();
        write("Jarvis:", brief);
        write(JSON.stringify({ intent, brief }, null, 2));
      } else if (inputText.toLowerCase().includes("motivate")) {
        const motivation = personalTraits.motivation();
        write("Jarvis:", motivation);
        write(JSON.stringify({ intent, motivation }, null, 2));
      } else {
        await saveRuntimeState({
          lastInput: inputText,
          lastIntent: intent,
          lastResult: result,
        });
        write("Jarvis:", reply);
        write(JSON.stringify({ intent, result }, null, 2));
      }
    }
  } finally {
    rl.close();
  }
}

export default runCli;
