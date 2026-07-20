import type { DomainEngine } from "./domainRouter.js";
import { asString, type Payload } from "./types.js";

interface Client {
  id: string;
  name: string;
}

type JobStatus = "new" | "scheduled" | "in_progress" | "completed" | "cancelled";

interface Job {
  id: string;
  clientId: string;
  description: string;
  status: JobStatus;
}

export class BusinessEngine implements DomainEngine {
  private readonly clients: Client[] = [{ id: "c1", name: "Default Client" }];
  private readonly jobs: Job[] = [];
  private sequence = 0;

  handle(action: string, payload: Payload): Promise<unknown> {
    return Promise.resolve(this.dispatch(action, payload));
  }

  private dispatch(action: string, payload: Payload): unknown {
    switch (action) {
      case "list_clients":
        return this.clients;
      case "add_client":
        return this.addClient(asString(payload.name, "Unnamed"));
      case "list_jobs":
        return this.jobs;
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

  private addClient(name: string): Client {
    const client: Client = { id: `c${(this.sequence += 1)}`, name };
    this.clients.push(client);
    return client;
  }

  private createJob(clientId: string, description: string): Job {
    const job: Job = {
      id: `j${(this.sequence += 1)}`,
      clientId,
      description,
      status: "new",
    };
    this.jobs.push(job);
    return job;
  }

  private setJobStatus(jobId: string, status: JobStatus): unknown {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return { error: "Job not found" };
    job.status = status;
    return job;
  }
}
