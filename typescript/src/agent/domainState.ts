import type { PersistenceProvider } from "../persistence/types.js";

export type JobStatus = "new" | "scheduled" | "in_progress" | "completed" | "cancelled";

export interface DomainClient {
  id: string;
  name: string;
}

export interface DomainJob {
  id: string;
  clientId: string;
  description: string;
  status: JobStatus;
}

export interface DomainTool {
  id: string;
  name: string;
  inUse: boolean;
}

export interface DomainInventoryItem {
  id: string;
  name: string;
  quantity: number;
}

export interface DomainScene {
  name: string;
  description: string;
}

export interface AgentDomainState {
  version: 1;
  business: {
    clients: DomainClient[];
    jobs: DomainJob[];
    sequence: number;
  };
  workshop: {
    tools: DomainTool[];
    inventory: DomainInventoryItem[];
  };
  home: {
    scenes: DomainScene[];
    activeScene?: string;
  };
}

export const AGENT_DOMAIN_STATE_KEY = "agentDomainState";

export function initialAgentDomainState(): AgentDomainState {
  return {
    version: 1,
    business: {
      clients: [{ id: "c1", name: "Default Client" }],
      jobs: [],
      sequence: 1,
    },
    workshop: {
      tools: [
        { id: "t1", name: "Drill", inUse: false },
        { id: "t2", name: "Saw", inUse: false },
      ],
      inventory: [
        { id: "i1", name: "Screws", quantity: 100 },
        { id: "i2", name: "Timber", quantity: 20 },
      ],
    },
    home: {
      scenes: [
        { name: "arrival", description: "Lights on, kettle on" },
        {
          name: "workshop_focus",
          description: "Workshop lights, music, tools ready",
        },
      ],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Persisted agent domain state has an invalid ${field}.`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Persisted agent domain state has an invalid ${field}.`);
  }
  return value;
}

function parseState(value: unknown): AgentDomainState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Persisted agent domain state has an unsupported version.");
  }

  const business = value.business;
  const workshop = value.workshop;
  const home = value.home;
  if (!isRecord(business) || !isRecord(workshop) || !isRecord(home)) {
    throw new Error("Persisted agent domain state is missing a domain.");
  }

  if (!Array.isArray(business.clients) || !Array.isArray(business.jobs)) {
    throw new Error("Persisted business domain state is malformed.");
  }
  const clients = business.clients.map((client, index) => {
    if (!isRecord(client)) throw new Error(`Persisted client ${index} is malformed.`);
    return {
      id: requiredString(client.id, `client ${index} id`),
      name: requiredString(client.name, `client ${index} name`),
    };
  });
  const validStatuses: readonly JobStatus[] = [
    "new",
    "scheduled",
    "in_progress",
    "completed",
    "cancelled",
  ];
  const jobs = business.jobs.map((job, index) => {
    if (!isRecord(job) || !validStatuses.includes(job.status as JobStatus)) {
      throw new Error(`Persisted job ${index} is malformed.`);
    }
    return {
      id: requiredString(job.id, `job ${index} id`),
      clientId: requiredString(job.clientId, `job ${index} clientId`),
      description: requiredString(job.description, `job ${index} description`),
      status: job.status as JobStatus,
    };
  });
  const sequence = requiredFiniteNumber(business.sequence, "business sequence");
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error("Persisted business domain state has an invalid sequence.");
  }

  if (!Array.isArray(workshop.tools) || !Array.isArray(workshop.inventory)) {
    throw new Error("Persisted workshop domain state is malformed.");
  }
  const tools = workshop.tools.map((tool, index) => {
    if (!isRecord(tool) || typeof tool.inUse !== "boolean") {
      throw new Error(`Persisted tool ${index} is malformed.`);
    }
    return {
      id: requiredString(tool.id, `tool ${index} id`),
      name: requiredString(tool.name, `tool ${index} name`),
      inUse: tool.inUse,
    };
  });
  const inventory = workshop.inventory.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Persisted inventory item ${index} is malformed.`);
    const quantity = requiredFiniteNumber(item.quantity, `inventory item ${index} quantity`);
    if (quantity < 0) throw new Error(`Persisted inventory item ${index} is negative.`);
    return {
      id: requiredString(item.id, `inventory item ${index} id`),
      name: requiredString(item.name, `inventory item ${index} name`),
      quantity,
    };
  });

  if (!Array.isArray(home.scenes)) {
    throw new Error("Persisted home domain state is malformed.");
  }
  const scenes = home.scenes.map((scene, index) => {
    if (!isRecord(scene)) throw new Error(`Persisted scene ${index} is malformed.`);
    return {
      name: requiredString(scene.name, `scene ${index} name`),
      description: requiredString(scene.description, `scene ${index} description`),
    };
  });
  if (home.activeScene !== undefined && typeof home.activeScene !== "string") {
    throw new Error("Persisted home active scene is malformed.");
  }

  return {
    version: 1,
    business: { clients, jobs, sequence },
    workshop: { tools, inventory },
    home: {
      scenes,
      ...(home.activeScene === undefined ? {} : { activeScene: home.activeScene }),
    },
  };
}

export function parseAgentDomainState(value: unknown): AgentDomainState {
  return parseState(value);
}

export interface DomainStateStore {
  readonly durable: boolean;
  load(): Promise<AgentDomainState>;
  update(mutator: (state: AgentDomainState) => AgentDomainState | void): Promise<AgentDomainState>;
}

export class InMemoryDomainStateStore implements DomainStateStore {
  readonly durable = false;
  private state = initialAgentDomainState();
  private pending: Promise<unknown> = Promise.resolve();

  async load(): Promise<AgentDomainState> {
    return this.enqueue(async () => clone(this.state));
  }

  async update(
    mutator: (state: AgentDomainState) => AgentDomainState | void,
  ): Promise<AgentDomainState> {
    return this.enqueue(async () => {
      const draft = clone(this.state);
      const next = mutator(draft) ?? draft;
      this.state = parseState(next);
      return clone(this.state);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class PersistentDomainStateStore implements DomainStateStore {
  readonly durable = true;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly persistence: PersistenceProvider) {}

  async load(): Promise<AgentDomainState> {
    return this.enqueue(async () => {
      const state = await this.persistence.loadState();
      const raw = state[AGENT_DOMAIN_STATE_KEY];
      return raw === undefined ? initialAgentDomainState() : clone(parseState(raw));
    });
  }

  async update(
    mutator: (state: AgentDomainState) => AgentDomainState | void,
  ): Promise<AgentDomainState> {
    return this.enqueue(async () => {
      const currentState = await this.persistence.loadState();
      const current = currentState[AGENT_DOMAIN_STATE_KEY];
      const draft = current === undefined ? initialAgentDomainState() : parseState(current);
      const working = clone(draft);
      const next = parseState(mutator(working) ?? working);
      await this.persistence.saveState({
        ...currentState,
        [AGENT_DOMAIN_STATE_KEY]: clone(next),
      });
      return clone(next);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
