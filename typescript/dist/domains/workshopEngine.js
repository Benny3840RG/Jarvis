export class WorkshopEngine {
    createTask(title, description, priority = "medium") {
        return {
            title,
            description,
            priority,
        };
    }
    summarize(task) {
        return `Workshop task: ${task.title} (${task.priority}) - ${task.description}`;
    }
}
