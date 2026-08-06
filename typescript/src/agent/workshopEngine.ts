import type { DomainEngine } from "./domainRouter.js";
import {
  InMemoryDomainStateStore,
  type DomainStateStore,
  type DomainTool,
  type DomainInventoryItem,
} from "./domainState.js";
import { asNumber, asString, type Payload } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class WorkshopEngine implements DomainEngine {
  constructor(private readonly store: DomainStateStore = new InMemoryDomainStateStore()) {}

  handle(action: string, payload: Payload): Promise<unknown> {
    return this.dispatch(action, payload);
  }

  private async dispatch(action: string, payload: Payload): Promise<unknown> {
    switch (action) {
      case "list_tools":
        return (await this.store.load()).workshop.tools;
      case "use_tool":
        return this.setToolInUse(asString(payload.toolId), true);
      case "release_tool":
        return this.setToolInUse(asString(payload.toolId), false);
      case "list_inventory":
        return (await this.store.load()).workshop.inventory;
      case "consume_item":
        return this.consumeItem(asString(payload.itemId), asNumber(payload.quantity));
      case "restock_item":
        return this.restockItem(asString(payload.itemId), asNumber(payload.quantity));
      case "prepare_job":
        return { jobId: asString(payload.jobId), status: "prepared" };
      case "complete_job":
        return { jobId: asString(payload.jobId), status: "completed" };
      default:
        return { error: `Unknown workshop action: ${action}` };
    }
  }

  private async setToolInUse(toolId: string, inUse: boolean): Promise<unknown> {
    let result: DomainTool | { error: string } = { error: "Tool not found" };
    await this.store.update((state) => {
      const tool = state.workshop.tools.find((candidate) => candidate.id === toolId);
      if (!tool) return;
      tool.inUse = inUse;
      result = tool;
    });
    return clone(result);
  }

  private async consumeItem(itemId: string, quantity: number): Promise<unknown> {
    if (quantity <= 0) return { error: "Quantity must be positive" };
    let result: DomainInventoryItem | { error: string } = { error: "Item not found" };
    await this.store.update((state) => {
      const item = state.workshop.inventory.find((candidate) => candidate.id === itemId);
      if (!item) return;
      if (item.quantity < quantity) {
        result = { error: "Insufficient quantity" };
        return;
      }
      item.quantity -= quantity;
      result = item;
    });
    return clone(result);
  }

  private async restockItem(itemId: string, quantity: number): Promise<unknown> {
    if (quantity <= 0) return { error: "Quantity must be positive" };
    let result: DomainInventoryItem | { error: string } = { error: "Item not found" };
    await this.store.update((state) => {
      const item = state.workshop.inventory.find((candidate) => candidate.id === itemId);
      if (!item) return;
      item.quantity += quantity;
      result = item;
    });
    return clone(result);
  }
}
