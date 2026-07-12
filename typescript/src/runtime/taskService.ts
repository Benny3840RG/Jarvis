export type Task = { id: string; title: string; completed: boolean; category: string };

export class TaskService {
  private readonly tasks: Task[];

  constructor(initial: Task[] = []) {
    this.tasks = initial.map((task) => ({ ...task }));
  }

  add(title: string, category: string): Task {
    const task = { id: `${Date.now()}`, title, completed: false, category };
    this.tasks.push(task);
    return task;
  }

  remember(task: Task): Task {
    const existing = this.tasks.find((entry) => entry.id === task.id);
    if (existing) {
      Object.assign(existing, task);
      return { ...existing };
    }
    this.tasks.push({ ...task });
    return { ...task };
  }

  list(): Task[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  complete(id: string): Task | undefined {
    const task = this.tasks.find((entry) => entry.id === id);
    if (task) task.completed = true;
    return task ? { ...task } : undefined;
  }
}
