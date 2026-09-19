import type { ApprovalResponse, MissionIntent, MissionState } from "../types.js";

/**
 * Backend-agnostic interface for starting/observing/approving PASS
 * missions. Jarvis should depend on this, not directly on Temporal (or
 * whatever durable-execution engine this experiment is compared against).
 */
export interface JarvisOrchestrator {
  startMission(intent: MissionIntent): Promise<{ missionId: string }>;
  getMissionState(missionId: string): Promise<MissionState>;
  sendApproval(missionId: string, approval: ApprovalResponse): Promise<void>;
  shutdown(): Promise<void>;
}
