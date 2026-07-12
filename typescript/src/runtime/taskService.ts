export type Task = { id: string; title: string; completed: boolean; category: string };

export class TaskService {
  private readonly tasks: Task[] = [];

  add(title: string, category: string): Task {
    const task = { id: `${Date.now()}`, title, completed: false, category };
    this.tasks.push(task);
    return task;
  }

  list(): Task[] {
    return [...this.tasks];
  }

  complete(id: string): Task | undefined {
    const task = this.tasks.find((entry) => entry.id === id);
    if (task) task.completed = true;
    return task;
  }
}
