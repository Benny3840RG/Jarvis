import type { Payload } from "./types.js";

export interface DomainEngine {
  handle(action: string, payload: Payload): Promise<unknown>;
}

export class DomainRouter {
  constructor(
    private readonly workshop: DomainEngine,
    private readonly business: DomainEngine,
    private readonly home: DomainEngine,
  ) {}

  async route(module: string, action: string, payload: Payload): Promise<unknown> {
    switch (module) {
      case "workshop":
        return this.workshop.handle(action, payload);
      case "business":
        return this.business.handle(action, payload);
      case "home":
        return this.home.handle(action, payload);
      default:
        return { error: `Unknown module: ${module}` };
    }
  }
}
