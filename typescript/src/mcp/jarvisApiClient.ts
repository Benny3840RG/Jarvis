import { randomUUID } from "node:crypto";

import type { DailyBrief } from "../briefs/brief.js";
import type { Client, ClientInput, ClientUpdate } from "../clients/client.js";
import type { Errand, ErrandInput, ErrandUpdate } from "../errands/errand.js";
import type { Build, BuildInput, BuildUpdate } from "../builds/build.js";
import type { BuildLogEntry, BuildLogInput, BuildLogUpdate } from "../buildLog/buildLogEntry.js";
import type { Upgrade, UpgradeInput, UpgradeUpdate } from "../upgrades/upgrade.js";
import type { AssetInput, AssetUpdate } from "../assets/asset.js";
import type { AssetView } from "../assets/assetView.js";
import type { Preference, PreferenceInput, PreferenceUpdate } from "../preferences/preference.js";
import type { Project, ProjectInput, ProjectUpdate } from "../projects/project.js";
import type { QuoteSnapshot } from "../quotes/quoteLifecycle.js";
import type { QuoteSummary } from "../quotes/quoteRepository.js";
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
  brief: DailyBrief;
  quotes: QuoteSummary[];
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

  async listClients(): Promise<Client[]> {
    return (await this.request<ListResponse<Client>>("GET", "/api/v1/clients")).data;
  }

  async getClient(clientId: string): Promise<Client> {
    return (
      await this.request<DataResponse<Client>>(
        "GET",
        `/api/v1/clients/${encodeURIComponent(clientId)}`,
      )
    ).data;
  }

  async createClient(input: ClientInput): Promise<Client> {
    return (await this.request<DataResponse<Client>>("POST", "/api/v1/clients", { body: input }))
      .data;
  }

  async updateClient(clientId: string, update: ClientUpdate): Promise<Client> {
    return (
      await this.request<DataResponse<Client>>(
        "PATCH",
        `/api/v1/clients/${encodeURIComponent(clientId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteClient(clientId: string): Promise<Client> {
    return (
      await this.request<DataResponse<Client>>(
        "DELETE",
        `/api/v1/clients/${encodeURIComponent(clientId)}`,
      )
    ).data;
  }

  async listProjects(): Promise<Project[]> {
    return (await this.request<ListResponse<Project>>("GET", "/api/v1/projects")).data;
  }

  async getProject(projectId: string): Promise<Project> {
    return (
      await this.request<DataResponse<Project>>(
        "GET",
        `/api/v1/projects/${encodeURIComponent(projectId)}`,
      )
    ).data;
  }

  async createProject(input: ProjectInput): Promise<Project> {
    return (await this.request<DataResponse<Project>>("POST", "/api/v1/projects", { body: input }))
      .data;
  }

  async updateProject(projectId: string, update: ProjectUpdate): Promise<Project> {
    return (
      await this.request<DataResponse<Project>>(
        "PATCH",
        `/api/v1/projects/${encodeURIComponent(projectId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteProject(projectId: string): Promise<Project> {
    return (
      await this.request<DataResponse<Project>>(
        "DELETE",
        `/api/v1/projects/${encodeURIComponent(projectId)}`,
      )
    ).data;
  }

  async listErrands(): Promise<Errand[]> {
    return (await this.request<ListResponse<Errand>>("GET", "/api/v1/errands")).data;
  }

  async getErrand(errandId: string): Promise<Errand> {
    return (
      await this.request<DataResponse<Errand>>(
        "GET",
        `/api/v1/errands/${encodeURIComponent(errandId)}`,
      )
    ).data;
  }

  async createErrand(input: ErrandInput): Promise<Errand> {
    return (await this.request<DataResponse<Errand>>("POST", "/api/v1/errands", { body: input }))
      .data;
  }

  async updateErrand(errandId: string, update: ErrandUpdate): Promise<Errand> {
    return (
      await this.request<DataResponse<Errand>>(
        "PATCH",
        `/api/v1/errands/${encodeURIComponent(errandId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteErrand(errandId: string): Promise<Errand> {
    return (
      await this.request<DataResponse<Errand>>(
        "DELETE",
        `/api/v1/errands/${encodeURIComponent(errandId)}`,
      )
    ).data;
  }

  async listBuilds(): Promise<Build[]> {
    return (await this.request<ListResponse<Build>>("GET", "/api/v1/builds")).data;
  }

  async getBuild(buildId: string): Promise<Build> {
    return (
      await this.request<DataResponse<Build>>(
        "GET",
        `/api/v1/builds/${encodeURIComponent(buildId)}`,
      )
    ).data;
  }

  async createBuild(input: BuildInput): Promise<Build> {
    return (await this.request<DataResponse<Build>>("POST", "/api/v1/builds", { body: input }))
      .data;
  }

  async updateBuild(buildId: string, update: BuildUpdate): Promise<Build> {
    return (
      await this.request<DataResponse<Build>>(
        "PATCH",
        `/api/v1/builds/${encodeURIComponent(buildId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteBuild(buildId: string): Promise<Build> {
    return (
      await this.request<DataResponse<Build>>(
        "DELETE",
        `/api/v1/builds/${encodeURIComponent(buildId)}`,
      )
    ).data;
  }

  async listBuildLogs(): Promise<BuildLogEntry[]> {
    return (await this.request<ListResponse<BuildLogEntry>>("GET", "/api/v1/build-logs")).data;
  }

  async getBuildLog(entryId: string): Promise<BuildLogEntry> {
    return (
      await this.request<DataResponse<BuildLogEntry>>(
        "GET",
        `/api/v1/build-logs/${encodeURIComponent(entryId)}`,
      )
    ).data;
  }

  async createBuildLog(input: BuildLogInput): Promise<BuildLogEntry> {
    return (
      await this.request<DataResponse<BuildLogEntry>>("POST", "/api/v1/build-logs", { body: input })
    ).data;
  }

  async updateBuildLog(entryId: string, update: BuildLogUpdate): Promise<BuildLogEntry> {
    return (
      await this.request<DataResponse<BuildLogEntry>>(
        "PATCH",
        `/api/v1/build-logs/${encodeURIComponent(entryId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteBuildLog(entryId: string): Promise<BuildLogEntry> {
    return (
      await this.request<DataResponse<BuildLogEntry>>(
        "DELETE",
        `/api/v1/build-logs/${encodeURIComponent(entryId)}`,
      )
    ).data;
  }

  async listUpgrades(): Promise<Upgrade[]> {
    return (await this.request<ListResponse<Upgrade>>("GET", "/api/v1/upgrades")).data;
  }

  async getUpgrade(upgradeId: string): Promise<Upgrade> {
    return (
      await this.request<DataResponse<Upgrade>>(
        "GET",
        `/api/v1/upgrades/${encodeURIComponent(upgradeId)}`,
      )
    ).data;
  }

  async createUpgrade(input: UpgradeInput): Promise<Upgrade> {
    return (await this.request<DataResponse<Upgrade>>("POST", "/api/v1/upgrades", { body: input }))
      .data;
  }

  async updateUpgrade(upgradeId: string, update: UpgradeUpdate): Promise<Upgrade> {
    return (
      await this.request<DataResponse<Upgrade>>(
        "PATCH",
        `/api/v1/upgrades/${encodeURIComponent(upgradeId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteUpgrade(upgradeId: string): Promise<Upgrade> {
    return (
      await this.request<DataResponse<Upgrade>>(
        "DELETE",
        `/api/v1/upgrades/${encodeURIComponent(upgradeId)}`,
      )
    ).data;
  }

  async listAssets(): Promise<AssetView[]> {
    return (await this.request<ListResponse<AssetView>>("GET", "/api/v1/assets")).data;
  }

  async getAsset(assetId: string): Promise<AssetView> {
    return (
      await this.request<DataResponse<AssetView>>(
        "GET",
        `/api/v1/assets/${encodeURIComponent(assetId)}`,
      )
    ).data;
  }

  async createAsset(input: AssetInput): Promise<AssetView> {
    return (await this.request<DataResponse<AssetView>>("POST", "/api/v1/assets", { body: input }))
      .data;
  }

  async updateAsset(assetId: string, update: AssetUpdate): Promise<AssetView> {
    return (
      await this.request<DataResponse<AssetView>>(
        "PATCH",
        `/api/v1/assets/${encodeURIComponent(assetId)}`,
        { body: update },
      )
    ).data;
  }

  async deleteAsset(assetId: string): Promise<AssetView> {
    return (
      await this.request<DataResponse<AssetView>>(
        "DELETE",
        `/api/v1/assets/${encodeURIComponent(assetId)}`,
      )
    ).data;
  }

  async listPreferences(): Promise<Preference[]> {
    return (await this.request<ListResponse<Preference>>("GET", "/api/v1/preferences")).data;
  }

  async getPreference(preferenceId: string): Promise<Preference> {
    return (
      await this.request<DataResponse<Preference>>(
        "GET",
        `/api/v1/preferences/${encodeURIComponent(preferenceId)}`,
      )
    ).data;
  }

  async createPreference(input: PreferenceInput): Promise<Preference> {
    return (
      await this.request<DataResponse<Preference>>("POST", "/api/v1/preferences", { body: input })
    ).data;
  }

  async updatePreference(preferenceId: string, update: PreferenceUpdate): Promise<Preference> {
    return (
      await this.request<DataResponse<Preference>>(
        "PATCH",
        `/api/v1/preferences/${encodeURIComponent(preferenceId)}`,
        { body: update },
      )
    ).data;
  }

  async deletePreference(preferenceId: string): Promise<Preference> {
    return (
      await this.request<DataResponse<Preference>>(
        "DELETE",
        `/api/v1/preferences/${encodeURIComponent(preferenceId)}`,
      )
    ).data;
  }

  async listQuotes(): Promise<QuoteSummary[]> {
    return (await this.request<ListResponse<QuoteSummary>>("GET", "/api/v1/quotes")).data;
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot> {
    return (
      await this.request<DataResponse<QuoteSnapshot>>(
        "GET",
        `/api/v1/quotes/${encodeURIComponent(quoteId)}`,
      )
    ).data;
  }

  async getDailyBrief(): Promise<DailyBrief> {
    return (await this.request<DataResponse<DailyBrief>>("GET", "/api/v1/brief")).data;
  }

  async dashboard(): Promise<DashboardSnapshot> {
    const [status, tasks, reminders, brief, quotes] = await Promise.all([
      this.getStatus(),
      this.listTasks(),
      this.listReminders(),
      this.getDailyBrief(),
      this.listQuotes(),
    ]);
    return {
      status,
      tasks,
      reminders,
      brief,
      quotes,
      counts: {
        activeTasks: tasks.filter((task) => !task.completed).length,
        completedTasks: tasks.filter((task) => task.completed).length,
        reminders: reminders.length,
      },
    };
  }
}
