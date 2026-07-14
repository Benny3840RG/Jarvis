export type ProjectStatus = "planned" | "active" | "blocked" | "completed" | "archived";
export type FactSource = "user" | "file" | "tool" | "measurement" | "inference";
export type AssumptionStatus = "unverified" | "verified" | "rejected";
export type ImpactLevel = "low" | "medium" | "high";
export type ConstraintType =
  "budget" | "time" | "access" | "material" | "tool" | "legal" | "safety" | "dimensional";
export type TaskStatus = "pending" | "active" | "blocked" | "done";
export type EventActor = "user" | "agent" | "tool";

export interface ProjectComponent {
  componentId: string;
  name: string;
  type: string;
  status: string;
  parentComponentId: string | null;
  attributes: Record<string, unknown>;
  notes: string;
}

export interface ProjectFact {
  factId: string;
  statement: string;
  source: FactSource;
  confidence: number;
  recordedAt: string;
}

export interface ProjectAssumption {
  assumptionId: string;
  statement: string;
  status: AssumptionStatus;
  impact: ImpactLevel;
}

export interface ProjectConstraint {
  constraintId: string;
  type: ConstraintType;
  value: unknown;
  hardConstraint: boolean;
}

export interface ProjectMeasurement {
  measurementId: string;
  name: string;
  value: number;
  unit: string;
  tolerance?: string;
  source: string;
}

export interface ProjectDecision {
  decisionId: string;
  decision: string;
  rationale: string;
  alternativesRejected: string[];
  timestamp: string;
}

export interface ProjectRisk {
  riskId: string;
  hazard: string;
  likelihood: number;
  consequence: number;
  controls: string[];
  residualRisk: ImpactLevel;
}

export interface ProjectTask {
  taskId: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  owner: string;
  dueAt: string | null;
}

export interface ProjectPreferences {
  outputStyle: string;
  communicationTone: string;
  detailLevel: string;
  unitSystem: "metric";
  locale: "en-AU";
}

export interface ProjectEvent {
  eventId: string;
  eventType: string;
  actor: EventActor;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ProjectMemory {
  projectId: string;
  projectName: string;
  projectType: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
  domains: string[];
  summary: string;
  components: ProjectComponent[];
  facts: ProjectFact[];
  assumptions: ProjectAssumption[];
  constraints: ProjectConstraint[];
  measurements: ProjectMeasurement[];
  decisions: ProjectDecision[];
  risks: ProjectRisk[];
  tasks: ProjectTask[];
  preferences: ProjectPreferences;
  events: ProjectEvent[];
}

export function assertProjectMemoryIntegrity(project: ProjectMemory): void {
  if (project.revision < 1 || !Number.isInteger(project.revision)) {
    throw new Error("Project revision must be a positive integer");
  }

  for (const fact of project.facts) {
    if (fact.confidence < 0 || fact.confidence > 1) {
      throw new Error(`Fact ${fact.factId} confidence must be between 0 and 1`);
    }
    if (fact.source === "inference" && fact.confidence === 1) {
      throw new Error(`Inferred fact ${fact.factId} cannot be authoritative`);
    }
  }

  for (const risk of project.risks) {
    if (
      risk.likelihood < 1 ||
      risk.likelihood > 5 ||
      risk.consequence < 1 ||
      risk.consequence > 5
    ) {
      throw new Error(`Risk ${risk.riskId} likelihood and consequence must be between 1 and 5`);
    }
  }

  const measurementKeys = new Set<string>();
  for (const measurement of project.measurements) {
    const key = `${measurement.name.trim().toLowerCase()}::${measurement.unit.trim().toLowerCase()}`;
    if (measurementKeys.has(key)) {
      throw new Error(`Conflicting or duplicate measurement key: ${key}`);
    }
    measurementKeys.add(key);
  }
}
