export type RuntimeEvent = {
  version: 1;
  sequence: number;
  id: string;
  type: string;
  occurredAt: string;
  correlationId: string;
  payload: Record<string, unknown>;
};

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

export type ListenerFailure = {
  eventSequence: number;
  eventType: string;
  message: string;
};

export class EventBus {
  private nextSequence = 1;
  private readonly listeners = new Map<string, Set<RuntimeEventListener>>();
  private readonly listenerFailures: ListenerFailure[] = [];

  subscribe(type: string, listener: RuntimeEventListener): () => void {
    const listeners = this.listeners.get(type) ?? new Set<RuntimeEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(type);
    };
  }

  async publish(
    type: string,
    payload: Record<string, unknown>,
    correlationId = "runtime",
  ): Promise<RuntimeEvent> {
    const event: RuntimeEvent = {
      version: 1,
      sequence: this.nextSequence++,
      id: `runtime-event-${String(this.nextSequence - 1)}`,
      type,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload: { ...payload },
    };
    const failures = await this.dispatch(event);
    if (failures.length > 0) {
      this.listenerFailures.push(...failures);
      const failureEvent: RuntimeEvent = {
        version: 1,
        sequence: this.nextSequence++,
        id: `runtime-event-${String(this.nextSequence - 1)}`,
        type: "runtime.listener.failed",
        occurredAt: new Date().toISOString(),
        correlationId,
        payload: {
          eventSequence: event.sequence,
          eventType: event.type,
          failureCount: failures.length,
        },
      };
      await this.dispatch(failureEvent);
    }
    return event;
  }

  failures(): readonly ListenerFailure[] {
    return this.listenerFailures.map((failure) => ({ ...failure }));
  }

  private async dispatch(event: RuntimeEvent): Promise<ListenerFailure[]> {
    const failures: ListenerFailure[] = [];
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      try {
        await listener(event);
      } catch (error: unknown) {
        failures.push({
          eventSequence: event.sequence,
          eventType: event.type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return failures;
  }
}

export type IntegrationContext = {
  correlationId: string;
  events: EventBus;
  memory: MemoryLinker;
};

export type DomainHandler = (
  action: string,
  payload: unknown,
  context: IntegrationContext,
) => unknown | Promise<unknown>;

export class DomainRegistry {
  private readonly domains = new Map<string, DomainHandler>();

  register(name: string, handler: DomainHandler): void {
    const key = name.trim();
    if (!key) throw new Error("Domain name is required.");
    if (this.domains.has(key)) throw new Error(`Domain already registered: ${key}`);
    this.domains.set(key, handler);
  }

  resolve(name: string): DomainHandler {
    const handler = this.domains.get(name);
    if (!handler) throw new Error(`Unknown domain: ${name}`);
    return handler;
  }

  has(name: string): boolean {
    return this.domains.has(name);
  }

  list(): readonly string[] {
    return Object.freeze([...this.domains.keys()]);
  }
}

export type ToolHandler = (
  payload: unknown,
  context: IntegrationContext,
) => unknown | Promise<unknown>;

export class ToolGateway {
  private readonly tools = new Map<string, ToolHandler>();

  register(tool: string, operation: string, handler: ToolHandler): void {
    const cleanTool = tool.trim();
    const cleanOperation = operation.trim();
    if (!cleanTool || !cleanOperation) throw new Error("Tool and operation are required.");
    const key = `${cleanTool}:${cleanOperation}`;
    if (this.tools.has(key)) throw new Error(`Tool already registered: ${key}`);
    this.tools.set(key, handler);
  }

  has(key: string): boolean {
    return this.tools.has(key);
  }

  async invoke(key: string, payload: unknown, context: IntegrationContext): Promise<unknown> {
    const handler = this.tools.get(key);
    if (!handler) throw new Error(`Unknown tool route: ${key}`);
    return handler(payload, context);
  }

  list(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }
}

export type MemoryLink = {
  correlationId: string;
  route: string;
  eventType: string;
  eventSequence: number;
  status: "started" | "completed" | "failed";
  linkedAt: string;
};

export class MemoryLinker {
  private readonly links = new Map<string, MemoryLink>();

  link(event: RuntimeEvent, route: string, status: MemoryLink["status"]): void {
    const key = `${event.correlationId}:${event.type}:${event.sequence}`;
    if (this.links.has(key)) return;
    this.links.set(key, {
      correlationId: event.correlationId,
      route,
      eventType: event.type,
      eventSequence: event.sequence,
      status,
      linkedAt: new Date().toISOString(),
    });
  }

  list(correlationId?: string): readonly MemoryLink[] {
    return Object.freeze(
      [...this.links.values()]
        .filter((link) => correlationId === undefined || link.correlationId === correlationId)
        .map((link) => ({ ...link })),
    );
  }
}

export class ToolRouter {
  constructor(
    private readonly events: EventBus,
    private readonly domains: DomainRegistry,
    private readonly tools: ToolGateway,
    private readonly memory: MemoryLinker,
  ) {}

  async route(
    module: string,
    action: string,
    payload: unknown,
    correlationId = "runtime",
  ): Promise<unknown> {
    const route = `${module}:${action}`;
    const context: IntegrationContext = { correlationId, events: this.events, memory: this.memory };
    const started = await this.events.publish("runtime.route.started", { route }, correlationId);
    this.memory.link(started, route, "started");
    try {
      const output = this.tools.has(route)
        ? await this.tools.invoke(route, payload, context)
        : await this.domains.resolve(module)(action, payload, context);
      const completed = await this.events.publish(
        "runtime.route.completed",
        { route },
        correlationId,
      );
      this.memory.link(completed, route, "completed");
      return output;
    } catch (error: unknown) {
      const failed = await this.events.publish(
        "runtime.route.failed",
        { route, errorCode: "handler-failed" },
        correlationId,
      );
      this.memory.link(failed, route, "failed");
      throw error;
    }
  }
}

export type RuntimeIntegrationCore = {
  events: EventBus;
  domains: DomainRegistry;
  tools: ToolGateway;
  memory: MemoryLinker;
  router: ToolRouter;
};

export function createRuntimeIntegrationCore(): RuntimeIntegrationCore {
  const events = new EventBus();
  const domains = new DomainRegistry();
  const tools = new ToolGateway();
  const memory = new MemoryLinker();
  return { events, domains, tools, memory, router: new ToolRouter(events, domains, tools, memory) };
}
