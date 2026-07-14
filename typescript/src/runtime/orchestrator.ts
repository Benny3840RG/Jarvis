import type { ParsedConversation } from "./conversationService.js";
import type { MemoryService } from "./memoryService.js";
import type { SafetyEnvelope } from "../safety/safetyEnvelope.js";

export type PlanStep = { module: string; action: string; payload: unknown };
export type ExecutionPlan = { steps: PlanStep[] };

export interface DomainRouter {
  route(module: string, action: string, payload: unknown): Promise<unknown>;
}

export class Orchestrator {
  constructor(
    private readonly memory: MemoryService,
    private readonly router: DomainRouter,
    private readonly safety: SafetyEnvelope,
  ) {}

  plan(input: ParsedConversation): ExecutionPlan {
    void this.memory;
    if (input.intent === "planning") {
      return { steps: [{ module: "domains", action: "plan", payload: input.text }] };
    }
    if (input.intent === "memory") {
      return { steps: [{ module: "memory", action: "recall", payload: input.text }] };
    }
    return { steps: [{ module: "runtime", action: "respond", payload: input.text }] };
  }

  async execute(plan: ExecutionPlan): Promise<{ outputs: unknown[]; safetyStatus: string }> {
    const outputs: unknown[] = [];
    for (const step of plan.steps) {
      outputs.push(await this.router.route(step.module, step.action, step.payload));
    }
    const safetyResult = this.safety.evaluate(outputs);
    return { outputs, safetyStatus: safetyResult.status };
  }
}
// src/domains/workshopEngine.ts

export interface Tool {
  id: string;
  name: string;
  status: "available" | "in_use" | "maintenance";
  lastUsed: Date | null;
}

export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
}

export interface WorkshopContext {
  tools: Tool[];
  inventory: InventoryItem[];
}

export interface WorkshopActionPayload {
  toolId?: string;
  itemId?: string;
  quantity?: number;
  jobId?: string;
  notes?: string;
}

export class WorkshopEngine {
  private tools: Tool[] = [];
  private inventory: InventoryItem[] = [];

  constructor(initialContext?: WorkshopContext) {
    if (initialContext) {
      this.tools = initialContext.tools ?? [];
      this.inventory = initialContext.inventory ?? [];
    }
  }

  // -----------------------------
  // TOOL MANAGEMENT
  // -----------------------------

  listTools() {
    return this.tools;
  }

  getTool(toolId: string) {
    return this.tools.find(t => t.id === toolId) ?? null;
  }

  useTool(toolId: string) {
    const tool = this.getTool(toolId);
    if (!tool) return { error: "Tool not found" };

    if (tool.status !== "available") {
      return { error: `Tool is currently ${tool.status}` };
    }

    tool.status = "in_use";
    tool.lastUsed = new Date();

    return { ok: true, tool };
  }

  releaseTool(toolId: string) {
    const tool = this.getTool(toolId);
    if (!tool) return { error: "Tool not found" };

    tool.status = "available";
    return { ok: true, tool };
  }

  sendToolToMaintenance(toolId: string, notes?: string) {
    const tool = this.getTool(toolId);
    if (!tool) return { error: "Tool not found" };

    tool.status = "maintenance";
    return { ok: true, tool, notes };
  }

  // -----------------------------
  // INVENTORY MANAGEMENT
  // -----------------------------

  listInventory() {
    return this.inventory;
  }

  getItem(itemId: string) {
    return this.inventory.find(i => i.id === itemId) ?? null;
  }

  consumeItem(itemId: string, quantity: number) {
    const item = this.getItem(itemId);
    if (!item) return { error: "Item not found" };

    if (item.quantity < quantity) {
      return { error: "Not enough stock" };
    }

    item.quantity -= quantity;
    return { ok: true, item };
  }

  restockItem(itemId: string, quantity: number) {
    const item = this.getItem(itemId);
    if (!item) return { error: "Item not found" };

    item.quantity += quantity;
    return { ok: true, item };
  }

  // -----------------------------
  // JOB-SITE OPERATIONS
  // -----------------------------

  prepareForJob(jobId: string) {
    return {
      ok: true,
      jobId,
      checklist: [
        "Check battery levels",
        "Verify tool availability",
        "Load required inventory",
        "Confirm PPE",
        "Review job notes"
      ]
    };
  }

  completeJob(jobId: string, notes?: string) {
    return {
      ok: true,
      jobId,
      timestamp: new Date(),
      notes: notes ?? "Job completed"
    };
  }

  // -----------------------------
  // MAIN ROUTER ENTRY POINT
  // -----------------------------

  async handle(action: string, payload: WorkshopActionPayload) {
    switch (action) {
      case "list_tools":
        return this.listTools();

      case "use_tool":
        return this.useTool(payload.toolId!);

      case "release_tool":
        return this.releaseTool(payload.toolId!);

      case "maintenance_tool":
        return this.sendToolToMaintenance(payload.toolId!, payload.notes);

      case "list_inventory":
        return this.listInventory();

      case "consume_item":
        return this.consumeItem(payload.itemId!, payload.quantity!);

      case "restock_item":
        return this.restockItem(payload.itemId!, payload.quantity!);

      case "prepare_job":
        return this.prepareForJob(payload.jobId!);

      case "complete_job":
        return this.completeJob(payload.jobId!, payload.notes);

      default:
        return { error: `Unknown workshop action: ${action}` };
    }
  }
}
