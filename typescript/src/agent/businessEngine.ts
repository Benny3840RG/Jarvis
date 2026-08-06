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
        return this.setJobStatus(asString(payload.jobId), "completed");
      case "cancel_job":
        return this.setJobStatus(asString(payload.jobId), "cancelled");
      default:
        return { error: `Unknown business action: ${action}` };
    }
  }

  private async addClient(name: string): Promise<unknown> {
    let created: { id: string; name: string } | undefined;
    await this.store.update((state) => {
      const id = `c${(state.business.sequence += 1)}`;
      created = { id, name };
      state.business.clients.push(created);
    });
    return clone(created);
  }

  private async createJob(clientId: string, description: string): Promise<unknown> {
    let created: DomainJob | undefined;
    await this.store.update((state) => {
      const id = `j${(state.business.sequence += 1)}`;
      created = { id, clientId, description, status: "new" };
      state.business.jobs.push(created);
    });
    return clone(created);
  }

  private async setJobStatus(jobId: string, status: JobStatus): Promise<unknown> {
    let result: DomainJob | { error: string } = { error: "Job not found" };
    await this.store.update((state) => {
      const job = state.business.jobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      job.status = status;
      result = job;
    });
    return clone(result);
  }
}
