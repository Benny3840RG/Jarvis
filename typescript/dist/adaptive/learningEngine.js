export class LearningEngine {
    history = [];
    observe(event) {
        this.history.push(event.toLowerCase());
    }
    suggest() {
        if (this.history.includes("plan workshop task")) {
            return "Next action: prepare a workshop-focused task plan.";
        }
        if (this.history.includes("plan home task")) {
            return "Next action: prepare a home-focused task plan.";
        }
        return "Next action: confirm the main objective and break it into steps.";
    }
}
