import type { Task } from "./taskService.js";

export class ProactiveAssistant {
  summarize(tasks: Task[]): string {
    const pending = tasks.filter((task) => !task.completed);
    if (pending.length === 0) {
      return "Everything is in good shape. You have no pending tasks.";
    }
    return `You have ${pending.length} pending task(s): ${pending.map((task) => task.title).join(", ")}.`;
  }
}
