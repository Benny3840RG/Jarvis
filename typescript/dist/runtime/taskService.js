export class TaskService {
    tasks = [];
    add(title, category) {
        const task = { id: `${Date.now()}`, title, completed: false, category };
        this.tasks.push(task);
        return task;
    }
    list() {
        return [...this.tasks];
    }
    complete(id) {
        const task = this.tasks.find((entry) => entry.id === id);
        if (task) {
            task.completed = true;
        }
        return task;
    }
}
