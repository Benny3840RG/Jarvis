import { ConversationService } from "./conversationService.js";
import { DomainRouter } from "./domainRouter.js";
import { BusinessEngine } from "./businessEngine.js";
import { HomeEngine } from "./homeEngine.js";
import { WorkshopEngine } from "./workshopEngine.js";
import { OrchestrationGraph, defaultGraphConfig } from "./graph.js";
import { HealthMonitor } from "./healthMonitor.js";
import { LearningEngine } from "./learningEngine.js";
import { MemoryConsolidator } from "./memoryConsolidator.js";
import { MemoryManager } from "./memoryManager.js";
import { MemoryService } from "./memoryService.js";
import { Orchestrator } from "./orchestrator.js";
import { PredictionEngine } from "./predictionEngine.js";
import { RuleEvolution } from "./ruleEvolution.js";
import { SafetyEnvelope } from "./safetyEnvelope.js";
import { ValidationSuite } from "./validationSuite.js";
import { WorkflowGenerator } from "./workflowGenerator.js";
import { ZState } from "./zState.js";

export interface AgentSystem {
  conversation: ConversationService;
  orchestrator: Orchestrator;
  learning: LearningEngine;
  prediction: PredictionEngine;
  memoryManager: MemoryManager;
  validation: ValidationSuite;
  zState: ZState;
}

/**
 * Composition root for the isolated agent simulation. Wires every module into a
 * single governed orchestrator. In-memory only; nothing persists. Without an
 * evidence-backed health monitor, autonomy fails closed with unknown health.
 */
export function createAgentSystem(health = new HealthMonitor()): AgentSystem {
  const conversation = new ConversationService();
  const memory = new MemoryService();

  const workshop = new WorkshopEngine();
  const business = new BusinessEngine();
  const home = new HomeEngine();

  const router = new DomainRouter(workshop, business, home);
  const safety = new SafetyEnvelope();
  const graph = new OrchestrationGraph(defaultGraphConfig);

  const learning = new LearningEngine();
  const prediction = new PredictionEngine();
  const workflowGen = new WorkflowGenerator();
  const ruleEvolution = new RuleEvolution();

  const memoryManager = new MemoryManager(new MemoryConsolidator());

  const zState = new ZState(workflowGen, ruleEvolution, safety, health, () => learning.getStats());

  const orchestrator = new Orchestrator(memory, router, safety, graph, zState, () =>
    learning.getHistory(),
  );

  const validation = new ValidationSuite({
    runtime: conversation,
    workshop,
    business,
    home,
    safety,
    graph,
    learning,
    zState,
    memoryManager,
  });

  return { conversation, orchestrator, learning, prediction, memoryManager, validation, zState };
}
