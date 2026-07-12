export type WorkflowMetadata = { priority: string; context: string };

export class WorkflowGenerator {
  createPlan(title: string, metadata: WorkflowMetadata) {
    return {
      title,
      priority: metadata.priority,
      steps: [
        { title: "Capture the main objective", kind: "task" },
        { title: `Review ${metadata.context}`, kind: "task" },
        { title: "Apply safety checks", kind: "safety" },
        { title: "Review progress and next actions", kind: "review" },
      ],
    };
  }
}
