export type WorkshopTask = { title: string; description: string; priority: string };

export class WorkshopEngine {
  createTask(title: string, description: string, priority = "medium"): WorkshopTask {
    return { title, description, priority };
  }

  summarize(task: WorkshopTask): string {
    return `Workshop task: ${task.title} (${task.priority}) - ${task.description}`;
  }
}
