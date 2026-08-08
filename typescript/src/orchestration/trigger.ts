import { OrchestrationGraph } from "./graph.js";

export type OrchestrationTriggerSource = "cli" | "http" | "mcp" | "scheduler";

export type OrchestrationTrigger = {
  readonly id: string;
  readonly kind: string;
  readonly source: OrchestrationTriggerSource;
  readonly idempotencyKey: string;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type OrchestrationGraphBuilder = (
  trigger: OrchestrationTrigger,
) => OrchestrationGraph | Promise<OrchestrationGraph>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Orchestration trigger ${name} is required.`);
  return normalized;
}

function validatedTrigger(trigger: OrchestrationTrigger): OrchestrationTrigger {
  const id = required(trigger.id, "id");
  const kind = required(trigger.kind, "kind");
  const idempotencyKey = required(trigger.idempotencyKey, "idempotencyKey");
  if (!Number.isFinite(trigger.occurredAt) || trigger.occurredAt < 0) {
    throw new Error("Orchestration trigger occurredAt must be a non-negative finite number.");
  }
  if (!["cli", "http", "mcp", "scheduler"].includes(trigger.source)) {
    throw new Error("Orchestration trigger source is invalid.");
  }

  return Object.freeze({
    id,
    kind,
    source: trigger.source,
    idempotencyKey,
    occurredAt: trigger.occurredAt,
    payload: deepFreeze(structuredClone(trigger.payload)),
  });
}

export class OrchestrationTriggerRegistry {
  private readonly builders = new Map<string, OrchestrationGraphBuilder>();

  register(kind: string, builder: OrchestrationGraphBuilder): void {
    const normalizedKind = required(kind, "kind");
    if (this.builders.has(normalizedKind)) {
      throw new Error(`Orchestration trigger kind already registered: ${normalizedKind}`);
    }
    this.builders.set(normalizedKind, builder);
  }

  async dispatch(trigger: OrchestrationTrigger): Promise<OrchestrationGraph> {
    const received = validatedTrigger(trigger);
    const builder = this.builders.get(received.kind);
    if (!builder) {
      throw new Error(`Unknown orchestration trigger kind: ${received.kind}`);
    }
    const graph = await builder(received);
    if (!(graph instanceof OrchestrationGraph)) {
      throw new Error(`Orchestration trigger builder returned an invalid graph: ${received.kind}`);
    }
    return graph;
  }

  list(): readonly string[] {
    return Object.freeze([...this.builders.keys()]);
  }
}
