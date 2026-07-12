import type { Task } from "../persistence/persistence.js";

export type { Task };

export class TaskService {
  private tasks: Task[];

  constructor(initial: Task[] = []) {
    this.tasks = initial.map((task) => ({ ...task }));
  }

  replace(tasks: Task[]): void {
    this.tasks = tasks.map((task) => ({ ...task }));
  }

  list(): Task[] {
    return this.tasks.map((task) => ({ ...task }));
  }
}
