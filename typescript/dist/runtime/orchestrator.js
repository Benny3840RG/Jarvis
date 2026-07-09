export class Orchestrator {
    memory;
    router;
    safety;
    constructor(memory, router, safety) {
        this.memory = memory;
        this.router = router;
        this.safety = safety;
    }
    plan(input) {
        const steps = [];
        if (input.intent === "planning") {
            steps.push({ module: "domains", action: "plan", payload: input.text });
        }
        else if (input.intent === "memory") {
            steps.push({ module: "memory", action: "recall", payload: input.text });
        }
        else {
            steps.push({ module: "runtime", action: "respond", payload: input.text });
        }
        return { steps };
    }
    async execute(plan) {
        const outputs = [];
        for (const step of plan.steps) {
            const result = await this.router.route(step.module, step.action, step.payload);
            outputs.push(result);
        }
        const safetyResult = this.safety.evaluate(outputs);
        return { outputs, safetyStatus: safetyResult.status };
    }
}
