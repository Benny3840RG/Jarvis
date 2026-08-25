import type { DomainEngine } from "./domainRouter.js";
import {
  InMemoryDomainStateStore,
  type DomainStateStore,
  type DomainJob,
  type JobStatus,
} from "./domainState.js";
import { asString, type Payload } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class BusinessEngine implements DomainEngine {
  constructor(private readonly store: DomainStateStore = new InMemoryDomainStateStore()) {}

  handle(action: string, payload: Payload): Promise<unknown> {
    return this.dispatch(action, payload);
  }

  private async dispatch(action: string, payload: Payload): Promise<unknown> {
    switch (action) {
      case "list_clients":
        return (await this.store.load()).business.clients;
      case "add_client":
        return this.addClient(asString(payload.name, "Unnamed"));
      case "list_jobs":
        return (await this.store.load()).business.jobs;
      case "create_job":
        return this.createJob(asString(payload.clientId), asString(payload.description));
      case "schedule_job":
        return this.setJobStatus(asString(payload.jobId), "scheduled");
      case "start_job":
        return this.setJobStatus(asString(payload.jobId), "in_progress");
      case "complete_job":
        return this.completeJob(asString(payload.jobId), payload.completionEvidenceRefs);
      case "cancel_job":
        return this.setJobStatus(asString(payload.jobId), "cancelled");
      default:
        return { error: `Unknown business action: ${action}` };
    }
  }

  private async addClient(name: string): Promise<unknown> {
    let created: { id: string; name: string } | undefined;
    await this.store.update((state) => {
      const client = { id: `c${(state.business.sequence += 1)}`, name };
      created = client;
      state.business.clients.push(client);
    });
    return clone(created);
  }

  private async createJob(clientId: string, description: string): Promise<unknown> {
    let created: DomainJob | undefined;
    await this.store.update((state) => {
      const job: DomainJob = {
        id: `j${(state.business.sequence += 1)}`,
        clientId,
        description,
        status: "new",
      };
      created = job;
      state.business.jobs.push(job);
    });
    return clone(created);
  }

  private async setJobStatus(jobId: string, status: JobStatus): Promise<unknown> {
    let result: DomainJob | { error: string } = { error: "Job not found" };
    await this.store.update((state) => {
      const job = state.business.jobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      const transition = `${job.status}:${status}`;
      const allowed = new Set([
        "new:scheduled",
        "new:in_progress",
        "new:cancelled",
        "scheduled:in_progress",
        "scheduled:cancelled",
        "in_progress:cancelled",
      ]);
      if (!allowed.has(transition)) {
        result = { error: `Job cannot transition from ${job.status} to ${status}` };
        return;
      }
      job.status = status;
      result = job;
    });
    return clone(result);
  }

  private async completeJob(jobId: string, rawEvidenceRefs: unknown): Promise<unknown> {
    const completionEvidenceRefs = normalizeEvidenceRefs(rawEvidenceRefs);
    if (completionEvidenceRefs.length === 0) {
      return { error: "Job completion requires at least one evidence reference" };
    }

    let result: DomainJob | { error: string } = { error: "Job not found" };
    await this.store.update((state) => {
      const job = state.business.jobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      if (job.status !== "in_progress") {
        result = { error: `Job cannot transition from ${job.status} to completed` };
        return;
      }
      job.status = "completed";
      job.completionEvidenceRefs = completionEvidenceRefs;
      job.completedAt = new Date().toISOString();
      result = job;
    });
    return clone(result);
  }
}

function normalizeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(refs)];
}
