export class BusinessEngine {
    createTask(title, description, dueDate) {
        return {
            title,
            description,
            dueDate,
        };
    }
    summarize(task) {
        const dueDate = task.dueDate ?? "";
        if (!dueDate) {
            return `Business task: ${task.title} - ${task.description}`;
        }
        return `Business task: ${task.title} - ${task.description} (due ${dueDate})`;
    }
}
