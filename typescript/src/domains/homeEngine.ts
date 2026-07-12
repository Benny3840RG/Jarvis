export type HomeTask = { title: string; description: string; room?: string };

export class HomeEngine {
  createTask(title: string, description: string, room?: string): HomeTask {
    return { title, description, room };
  }

  summarize(task: HomeTask): string {
    if (!task.room) return `Home task: ${task.title} - ${task.description}`;
    return `Home task: ${task.title} - ${task.description} (${task.room})`;
  }
}
