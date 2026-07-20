import type { ConversationService } from "./conversationService.js";
import type { DomainEngine } from "./domainRouter.js";
import type { OrchestrationGraph } from "./graph.js";
import type { LearningEngine } from "./learningEngine.js";
import type { MemoryManager } from "./memoryManager.js";
import type { SafetyEnvelope } from "./safetyEnvelope.js";
import type { ZState } from "./zState.js";

export interface ValidationResult {
  name: string;
  passed: boolean;
  details?: unknown;
}

export interface ValidationDependencies {
  runtime: ConversationService;
  workshop: DomainEngine;
  business: DomainEngine;
  home: DomainEngine;
  safety: SafetyEnvelope;
  graph: OrchestrationGraph;
  learning: LearningEngine;
  zState: ZState;
  memoryManager: MemoryManager;
}

export class ValidationSuite {
  constructor(private readonly deps: ValidationDependencies) {}

  validateRuntime(): ValidationResult {
    const parsed = this.deps.runtime.parse("start job j1");
    return {
      name: "Runtime",
      passed: parsed.intent === "start_job" && parsed.entities.jobId === "j1",
      details: parsed,
    };
  }

  validateDomains(): ValidationResult {
    const workshopOK = typeof this.deps.workshop.handle === "function";
    const businessOK = typeof this.deps.business.handle === "function";
    const homeOK = typeof this.deps.home.handle === "function";
    return {
      name: "Domains",
      passed: workshopOK && businessOK && homeOK,
      details: { workshopOK, businessOK, homeOK },
    };
  }

  validateSafety(): ValidationResult {
    const ok = this.deps.safety.evaluate({
      domain: "workshop",
      action: "use_tool",
      payload: { toolId: "t1" },
      outputs: [],
    });
    const blocked = this.deps.safety.evaluate({
      domain: "workshop",
      action: "use_tool",
      payload: {},
      outputs: [],
    });
    return {
      name: "Safety",
      passed: ok.status === "ok" && blocked.status === "blocked",
      details: { ok, blocked },
    };
  }

  validateGraph(): ValidationResult {
    const nodes = this.deps.graph.getNodesForIntent("start_job");
    return { name: "Graph", passed: nodes.length > 0, details: nodes };
  }

  validateAdaptive(): ValidationResult {
    const history = this.deps.learning.getHistory();
    return {
      name: "Adaptive",
      passed: Array.isArray(history),
      details: { records: history.length },
    };
  }

  validateZState(): ValidationResult {
    // With no history, autonomy must refuse to activate.
    const report = this.deps.zState.canActivate("start_job", [], []);
    return {
      name: "ZState",
      passed: report.active === false && report.reasons.includes("Insufficient adaptive history"),
      details: report,
    };
  }

  validateMemory(): ValidationResult {
    const snapshot = this.deps.memoryManager.snapshot();
    return {
      name: "Memory",
      passed: Array.isArray(snapshot.shortTerm) && Array.isArray(snapshot.lineage),
      details: { shortTerm: snapshot.shortTerm.length, lineage: snapshot.lineage.length },
    };
  }

  runAll(): ValidationResult[] {
    return [
      this.validateRuntime(),
      this.validateDomains(),
      this.validateSafety(),
      this.validateGraph(),
      this.validateAdaptive(),
      this.validateZState(),
      this.validateMemory(),
    ];
  }
}
