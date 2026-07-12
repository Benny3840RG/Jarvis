import type { Intent } from "./conversationService.js";

export class AssistantResponse {
  format(intent: Intent, text: string): string {
    const normalized = text.trim();
    switch (intent) {
      case "greeting":
        return "Good evening, sir. Jarvis systems are online and ready to assist with planning, reminders, task tracking, memory, and daily briefings.";
      case "planning":
        return "Understood. I’m preparing a structured plan across your priorities and systems, including workshop, business, and home tasks.";
      case "memory":
        return "Recorded. I’ll retain that context and integrate it into your active profile while keeping your reminders and tasks in sync.";
      default:
        return `I’m monitoring your requests and preparing the appropriate response. ${normalized ? `You said: ${normalized}` : ""}`.trim();
    }
  }
}
