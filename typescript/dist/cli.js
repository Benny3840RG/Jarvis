import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ConversationService } from "./runtime/conversationService.js";
import { MemoryService } from "./runtime/memoryService.js";
import { StateService } from "./runtime/stateService.js";
import { IntentRouter } from "./runtime/intentRouter.js";
import { AssistantResponse } from "./runtime/assistantResponse.js";
import { PersistentState } from "./runtime/persistentState.js";
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
export async function runCli() {
    const rl = readline.createInterface({ input, output });
    const conversation = new ConversationService();
    const memory = new MemoryService();
    const router = new IntentRouter();
    const responseFormatter = new AssistantResponse();
    const state = new StateService();
    const persistentState = new PersistentState("./data/jarvis-state.json");
    const previousState = persistentState.load();
    if (previousState) {
        Object.entries(previousState).forEach(([key, value]) => {
            state.set(key, value);
        });
    }
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
        async route(module, action, payload) {
            if (module === "domains" && action === "plan") {
                const workshopTask = workshop.createTask("Prototype Jarvis", "Create the first workshop task", "high");
                const businessTask = business.createTask("Submit build update", "Share the current Jarvis progress", "2026-07-11");
                const homeTask = home.createTask("Reset living room", "Tidy up the living room", "living room");
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
    console.log("Jarvis CLI ready. Type 'exit' to quit.");
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
            console.log("Jarvis:", `${reply}\nWorkflow: ${JSON.stringify(workflow)}`);
            console.log(JSON.stringify({ intent, result, workflow, suggestion: learningEngine.suggest() }, null, 2));
        }
        else if (inputText.toLowerCase().includes("remind")) {
            const reminder = reminderService.add(inputText, "tomorrow");
            persistentState.save({ ...state.snapshot(), lastInput: inputText, lastIntent: intent, lastReminder: reminder });
            console.log("Jarvis:", `Reminder set: ${reminder.title} for ${reminder.due}`);
            console.log(JSON.stringify({ intent, reminder }, null, 2));
        }
        else if (inputText.toLowerCase().includes("task")) {
            const task = taskService.add(inputText, "personal");
            persistentState.save({ ...state.snapshot(), lastInput: inputText, lastIntent: intent, lastTask: task });
            console.log("Jarvis:", `Task added: ${task.title}`);
            console.log(JSON.stringify({ intent, task }, null, 2));
        }
        else if (inputText.toLowerCase().includes("summary")) {
            const summary = proactiveAssistant.summarize(taskService.list());
            console.log("Jarvis:", summary);
            console.log(JSON.stringify({ intent, summary }, null, 2));
        }
        else if (inputText.toLowerCase().includes("remember")) {
            const recall = contextMemory.recall("milk");
            console.log("Jarvis:", `I remember: ${recall.join(", ") || "nothing yet"}`);
            console.log(JSON.stringify({ intent, recall }, null, 2));
        }
        else if (inputText.toLowerCase().includes("brief")) {
            console.log("Jarvis:", personalTraits.dailyBrief());
            console.log(JSON.stringify({ intent, brief: personalTraits.dailyBrief() }, null, 2));
        }
        else if (inputText.toLowerCase().includes("motivate")) {
            console.log("Jarvis:", personalTraits.motivation());
            console.log(JSON.stringify({ intent, motivation: personalTraits.motivation() }, null, 2));
        }
        else {
            persistentState.save({ ...state.snapshot(), lastInput: inputText, lastIntent: intent, lastResult: result });
            console.log("Jarvis:", reply);
            console.log(JSON.stringify({ intent, result }, null, 2));
        }
    }
    rl.close();
}
