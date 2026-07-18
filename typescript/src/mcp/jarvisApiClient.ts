import { randomUUID } from "node:crypto";

import type { SystemStatus } from "../http/contracts.js";
import type { Reminder, Task } from "../persistence/persistence.js";
import type { TaskUpdate } from "../persistence/updates.js";
import type { JarvisApiConfig } from "./config.js";

export type ReminderRequestUpdate = {
  title?: string;
  due?: { text: string; timezone?: string } | null;
};

export type DashboardSnapshot = {
  status: SystemStatus;
  tasks: Task[];
  reminders: Reminder[];
  counts: {
    activeTasks: number;
    completedTasks: number;
    reminders: number;
  };
};

type DataResponse<T> = { data: T };
type ListResponse<T> = { data: T[]; count: number };

type ProblemDetails = {
  type?: unknown;
  title?: unknown;
  status?: unknown;
  detail?: unknown;
  requestId?: unknown;
};

export class JarvisApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problemType: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "JarvisApiError";
  }
}

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProblem(payload: unknown): ProblemDetails | null {
  return isRecord(payload) ? payload : null;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class JarvisApiClient {
  constructor(
    private readonly config: JarvisApiConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.config.baseUrl);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.serviceToken}`,
      "X-Request-Id": `mcp-${randomUUID()}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new JarvisApiError(`Jarvis API network request failed: ${message}`, 503, null, null);
    }

    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      const problem = safeProblem(payload);
      const title = textField(problem?.title);
      const detail = textField(problem?.detail);
      const message =
        [title, detail].filter(Boolean).join(": ") ||
        `Jarvis API returned HTTP ${response.status}.`;
      throw new JarvisApiError(
        message,
        response.status,
        textField(problem?.type),
        textField(problem?.requestId),
      );
    }
    if (payload === null) {
      throw new JarvisApiError(
        "Jarvis API returned an empty or non-JSON success response.",
        502,
        null,
        null,
      );
    }
    return payload as T;
  }

  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>("GET", "/api/v1/status");
  }

  async listTasks(): Promise<Task[]> {
    return (await this.request<ListResponse<Task>>("GET", "/api/v1/tasks")).data;
  }

  async getTask(taskId: string): Promise<Task> {
    return (
      await this.request<DataResponse<Task>>("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`)
    ).data;
  }

  async createTask(title: string, category?: string): Promise<Task> {
    return (
      await this.request<DataResponse<Task>>("POST", "/api/v1/tasks", {
        body: { title, ...(category === undefined ? {} : { category }) },
        idempotencyKey: `mcp-${randomUUID()}`,
      })
    ).data;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    return (
      await this.request<DataResponse<Task>>(
        "PATCH",
        `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        { body: update },
      )
    ).data;
  }

  async completeTask(taskId: string): Promise<Task> {
    return (
      await this.request<DataResponse<Task>>(
        "POST",
        `/api/v1/tasks/${encodeURIComponent(taskId)}/complete`,
      )
    ).data;
  }

  async deleteTask(taskId: string): Promise<Task> {
    return (
      await this.request<DataResponse<Task>>(
        "DELETE",
        `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      )
    ).data;
  }

  async listReminders(): Promise<Reminder[]> {
    return (await this.request<ListResponse<Reminder>>("GET", "/api/v1/reminders")).data;
  }

  async getReminder(reminderId: string): Promise<Reminder> {
    return (
      await this.request<DataResponse<Reminder>>(
        "GET",
        `/api/v1/reminders/${encodeURIComponent(reminderId)}`,
      )
    ).data;
  }

  async createReminder(
    title: string,
    due?: { text: string; timezone?: string },
  ): Promise<Reminder> {
    return (
      await this.request<DataResponse<Reminder>>("POST", "/api/v1/reminders", {
        body: { title, ...(due === undefined ? {} : { due }) },
        idempotencyKey: `mcp-${randomUUID()}`,
      })
    ).data;
  }

  async updateReminder(reminderId: string, update: ReminderRequestUpdate): Promise<Reminder> {
    return (
      await this.request<DataResponse<Reminder>>(
        "PATCH",
        `/api/v1/reminders/${encodeURIComponent(reminderId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteReminder(reminderId: string): Promise<Reminder> {
    return (
      await this.request<DataResponse<Reminder>>(
        "DELETE",
        `/api/v1/reminders/${encodeURIComponent(reminderId)}`,
      )
    ).data;
  }

  async dashboard(): Promise<DashboardSnapshot> {
    const [status, tasks, reminders] = await Promise.all([
      this.getStatus(),
      this.listTasks(),
      this.listReminders(),
    ]);
    return {
      status,
      tasks,
      reminders,
      counts: {
        activeTasks: tasks.filter((task) => !task.completed).length,
        completedTasks: tasks.filter((task) => task.completed).length,
        reminders: reminders.length,
      },
    };
  }
}
