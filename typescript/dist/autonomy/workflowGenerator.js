export class WorkflowGenerator {
    createPlan(title, metadata) {
        return {
            title,
            steps: [
                { title: "Capture the main objective", kind: "task" },
                { title: `Review ${metadata.context}`, kind: "task" },
                { title: "Apply safety checks", kind: "safety" },
                { title: "Review progress and next actions", kind: "review" },
            ],
        };
    }
}
