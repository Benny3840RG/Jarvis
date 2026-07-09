export class HomeEngine {
    createTask(title, description, room) {
        return {
            title,
            description,
            room,
        };
    }
    summarize(task) {
        if (!task.room) {
            return `Home task: ${task.title} - ${task.description}`;
        }
        return `Home task: ${task.title} - ${task.description} (${task.room})`;
    }
}
