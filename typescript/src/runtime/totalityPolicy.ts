export const TASK_TYPES = [
  "engineering_analysis",
  "fabrication_planning",
  "automation_design",
  "robotics_vehicle_logic",
  "safety_review",
  "documentation_manual",
  "branding_communication",
  "project_management",
  "comparison_tradeoff",
  "optimization",
  "simulation",
  "prediction",
  "integration",
  "general_analysis",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const OUTPUT_STYLES = [
  "for_benny_engineering",
  "for_benny_workshop",
  "for_client",
  "default",
] as const;

export type OutputStyle = (typeof OUTPUT_STYLES)[number];

export const MODES = [
  "engineering",
  "fabrication",
  "workshop",
  "tactical",
  "automation",
  "vehicle",
  "safety",
  "documentation",
  "client",
  "analysis",
  "optimization",
  "simulation",
  "prediction",
  "integration",
] as const;

export type OperationalMode = (typeof MODES)[number];
export type RiskLevel = "low" | "moderate" | "high" | "critical";
export type ReasoningLevel = "R0" | "R1" | "R2" | "R3";
export type ToolAuthority = "T0" | "T1" | "T2" | "T3";
export type DataAccess = "D0" | "D1" | "D2" | "D3";
export type ActionState = "read" | "propose" | "approve" | "execute";

export interface RoutingInput {
  taskType: TaskType;
  outputStyle?: OutputStyle;
  domainContext?: string[];
  safetySignals?: string[];
}

export interface PermissionEnvelope {
  reasoningLevel: ReasoningLevel;
  riskLevel: RiskLevel;
  toolAuthority: ToolAuthority;
  dataAccess: DataAccess;
  actionState: ActionState;
}

export interface RoutingDecision {
  primaryMode: OperationalMode;
  supportingModes: OperationalMode[];
  permission: PermissionEnvelope;
  confidence: number;
  reasonCodes: string[];
}

const TASK_MODE_MAP: Record<TaskType, OperationalMode> = {
  engineering_analysis: "engineering",
  fabrication_planning: "fabrication",
  automation_design: "automation",
  robotics_vehicle_logic: "vehicle",
  safety_review: "safety",
  documentation_manual: "documentation",
  branding_communication: "client",
  project_management: "tactical",
  comparison_tradeoff: "analysis",
  optimization: "optimization",
  simulation: "simulation",
  prediction: "prediction",
  integration: "integration",
  general_analysis: "analysis",
};

const STYLE_MODE_MAP: Record<OutputStyle, OperationalMode | null> = {
  for_benny_engineering: "engineering",
  for_benny_workshop: "workshop",
  for_client: "client",
  default: null,
};

const HIGH_RISK_TASKS = new Set<TaskType>([
  "fabrication_planning",
  "automation_design",
  "robotics_vehicle_logic",
  "safety_review",
]);

function uniqueModes(modes: OperationalMode[]): OperationalMode[] {
  return [...new Set(modes)];
}

function determineRisk(input: RoutingInput): RiskLevel {
  if (input.safetySignals?.some((signal) => signal === "critical")) {
    return "critical";
  }
  if ((input.safetySignals?.length ?? 0) > 0 || HIGH_RISK_TASKS.has(input.taskType)) {
    return "high";
  }
  if (input.taskType === "engineering_analysis" || input.taskType === "simulation") {
    return "moderate";
  }
  return "low";
}

function determineReasoningLevel(mode: OperationalMode): ReasoningLevel {
  if (["integration", "optimization", "simulation"].includes(mode)) {
    return "R3";
  }
  if (["engineering", "fabrication", "automation", "vehicle", "safety"].includes(mode)) {
    return "R2";
  }
  if (["workshop", "tactical", "analysis", "prediction"].includes(mode)) {
    return "R1";
  }
  return "R0";
}

export function routeTotalityTask(input: RoutingInput): RoutingDecision {
  const styleOverride = STYLE_MODE_MAP[input.outputStyle ?? "default"];
  const taskMode = TASK_MODE_MAP[input.taskType];
  const primaryMode = styleOverride ?? taskMode;
  const riskLevel = determineRisk(input);
  const supportingModes: OperationalMode[] = [];
  const reasonCodes = [`TASK_${input.taskType.toUpperCase()}`];

  if (styleOverride) {
    reasonCodes.push(`STYLE_OVERRIDE_${input.outputStyle?.toUpperCase()}`);
  }

  if (riskLevel === "high" || riskLevel === "critical") {
    supportingModes.push("safety");
    reasonCodes.push("SAFETY_INJECTION");
  }

  if ((input.domainContext?.length ?? 0) > 1 && primaryMode !== "integration") {
    supportingModes.push("integration");
    reasonCodes.push("MULTI_DOMAIN_INTEGRATION");
  }

  return {
    primaryMode,
    supportingModes: uniqueModes(supportingModes.filter((mode) => mode !== primaryMode)),
    permission: {
      reasoningLevel: determineReasoningLevel(primaryMode),
      riskLevel,
      toolAuthority: "T1",
      dataAccess: "D2",
      actionState: "propose",
    },
    confidence: styleOverride ? 1 : 0.95,
    reasonCodes,
  };
}
