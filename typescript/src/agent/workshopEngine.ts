import type { DomainEngine } from "./domainRouter.js";
import { asNumber, asString, type Payload } from "./types.js";

interface Tool {
  id: string;
  name: string;
  inUse: boolean;
}

interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
}

export class WorkshopEngine implements DomainEngine {
  private readonly tools: Tool[] = [
    { id: "t1", name: "Drill", inUse: false },
    { id: "t2", name: "Saw", inUse: false },
  ];

  private readonly inventory: InventoryItem[] = [
    { id: "i1", name: "Screws", quantity: 100 },
    { id: "i2", name: "Timber", quantity: 20 },
  ];

  handle(action: string, payload: Payload): Promise<unknown> {
    return Promise.resolve(this.dispatch(action, payload));
  }

  private dispatch(action: string, payload: Payload): unknown {
    switch (action) {
      case "list_tools":
        return this.tools;
      case "use_tool":
        return this.setToolInUse(asString(payload.toolId), true);
      case "release_tool":
        return this.setToolInUse(asString(payload.toolId), false);
      case "list_inventory":
        return this.inventory;
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

  private setToolInUse(toolId: string, inUse: boolean): unknown {
    const tool = this.tools.find((candidate) => candidate.id === toolId);
    if (!tool) return { error: "Tool not found" };
    tool.inUse = inUse;
    return tool;
  }

  private consumeItem(itemId: string, quantity: number): unknown {
    const item = this.inventory.find((candidate) => candidate.id === itemId);
    if (!item) return { error: "Item not found" };
    if (item.quantity < quantity) return { error: "Insufficient quantity" };
    item.quantity -= quantity;
    return item;
  }

  private restockItem(itemId: string, quantity: number): unknown {
    const item = this.inventory.find((candidate) => candidate.id === itemId);
    if (!item) return { error: "Item not found" };
    item.quantity += quantity;
    return item;
  }
}
