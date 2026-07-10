export type TaskRow = {
  id?: string;
  title: string;
  completed?: boolean;
  createdAt?: string; // ISO
  [key: string]: unknown;
};

export type ReminderRow = {
  id?: string;
  title: string;
  due?: string; // ISO or human string
  createdAt?: string;
  [key: string]: unknown;
};

export type MemoryRow = {
  id?: string;
  text: string;
  createdAt?: string;
};

export type ConversationRow = {
  id?: string;
  messages: Array<{ role: string; text: string; timestamp?: string }>;
  createdAt?: string;
};

export type AssistantStateRow = {
  id?: string;
  state: Record<string, unknown>;
  updatedAt?: string;
};
