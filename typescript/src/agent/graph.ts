export interface OrchestrationNode {
  module: string;
  action: string;
  weight?: number;
}

export type OrchestrationGraphConfig = Record<string, OrchestrationNode[]>;

export class OrchestrationGraph {
  constructor(private readonly config: OrchestrationGraphConfig) {}

  getNodesForIntent(intent: string): OrchestrationNode[] {
    return this.config[intent] ?? [];
  }
}

export const defaultGraphConfig: OrchestrationGraphConfig = {
  start_job: [
    { module: "business", action: "start_job", weight: 1 },
    { module: "workshop", action: "prepare_job", weight: 0.9 },
  ],
  prepare_job: [{ module: "workshop", action: "prepare_job", weight: 1 }],
  complete_job: [
    { module: "workshop", action: "complete_job", weight: 1 },
    { module: "business", action: "complete_job", weight: 0.9 },
    { module: "home", action: "activate_scene", weight: 0.5 },
  ],
};
