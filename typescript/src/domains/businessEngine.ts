export type BusinessTask = { title: string; description: string; dueDate?: string };

export class BusinessEngine {
  createTask(title: string, description: string, dueDate?: string): BusinessTask {
    return { title, description, dueDate };
  }

  summarize(task: BusinessTask): string {
    if (!task.dueDate) return `Business task: ${task.title} - ${task.description}`;
    return `Business task: ${task.title} - ${task.description} (due ${task.dueDate})`;
  }
}
