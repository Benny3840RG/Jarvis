import { ConversationService } from "./conversationService.js";
import { DomainRouter } from "./domainRouter.js";
import { BusinessEngine } from "./businessEngine.js";
import { HomeEngine } from "./homeEngine.js";
import { WorkshopEngine } from "./workshopEngine.js";
import {
  InMemoryDomainStateStore,
  PersistentDomainStateStore,
  type DomainStateStore,
} from "./domainState.js";
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
import type { PersistenceProvider } from "../persistence/types.js";

export interface AgentSystem {
  conversation: ConversationService;
  orchestrator: Orchestrator;
  learning: LearningEngine;
  prediction: PredictionEngine;
  memoryManager: MemoryManager;
  validation: ValidationSuite;
  zState: ZState;
  domainStateStore: DomainStateStore;
}

export interface AgentSystemOptions {
  health?: HealthMonitor;
  persistence?: PersistenceProvider;
  domainStateStore?: DomainStateStore;
}

/**
 * Composition root for the governed agent runtime. Domain state is durable when
 * a Jarvis persistence provider is supplied; tests may inject the explicit
 * in-memory store without confusing it for the maintained runtime.
 */
export function createAgentSystem(
  healthOrOptions: HealthMonitor | AgentSystemOptions = new HealthMonitor(),
): AgentSystem {
  const options: AgentSystemOptions =
    healthOrOptions instanceof HealthMonitor ? { health: healthOrOptions } : healthOrOptions;
  const health = options.health ?? new HealthMonitor();
  const domainStateStore =
    options.domainStateStore ??
    (options.persistence
      ? new PersistentDomainStateStore(options.persistence)
      : new InMemoryDomainStateStore());

  const conversation = new ConversationService();
  const memory = new MemoryService();

  const workshop = new WorkshopEngine(domainStateStore);
  const business = new BusinessEngine(domainStateStore);
  const home = new HomeEngine(domainStateStore);

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

  return {
    conversation,
    orchestrator,
    learning,
    prediction,
    memoryManager,
    validation,
    zState,
    domainStateStore,
  };
}
