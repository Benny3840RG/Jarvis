import type { OrchestrationCommand } from "./contracts.js";

export type GraphNode = { id: string; kind: string };
export type GraphEdge = { from: string; to: string };

export type OrchestrationNode = {
  id: string;
  command: OrchestrationCommand;
  dependsOn?: readonly string[];
};

export class OrchestrationGraph {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly commandNodes: readonly OrchestrationNode[];
  private readonly commandNodesById: ReadonlyMap<string, OrchestrationNode>;

  constructor(commandNodes: readonly OrchestrationNode[] = []) {
    const copies = commandNodes.map((node) => ({
      ...node,
      dependsOn: node.dependsOn === undefined ? undefined : [...node.dependsOn],
    }));
    const byId = new Map<string, OrchestrationNode>();

    for (const node of copies) {
      if (node.id.trim().length === 0) throw new Error("Orchestration node IDs must not be blank.");
      if (byId.has(node.id)) throw new Error(`Duplicate orchestration node ID: ${node.id}`);
      byId.set(node.id, node);
    }

    for (const node of copies) {
      const dependencies = node.dependsOn ?? [];
      if (new Set(dependencies).size !== dependencies.length) {
        throw new Error(`Orchestration node ${node.id} has duplicate dependencies.`);
      }
      for (const dependencyId of dependencies) {
        if (dependencyId === node.id) {
          throw new Error(`Orchestration node ${node.id} cannot depend on itself.`);
        }
        if (!byId.has(dependencyId)) {
          throw new Error(`Orchestration node ${node.id} depends on unknown node ${dependencyId}.`);
        }
      }
    }

    this.commandNodes = copies;
    this.commandNodesById = byId;
    void this.orderedNodes();
  }

  addNode(node: GraphNode): void {
    this.nodes.push(node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
  }

  getPlan(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: [...this.nodes], edges: [...this.edges] };
  }

  orderedNodes(): readonly OrchestrationNode[] {
    const ordered: OrchestrationNode[] = [];
    const state = new Map<string, "visiting" | "visited">();

    const visit = (node: OrchestrationNode): void => {
      const current = state.get(node.id);
      if (current === "visited") return;
      if (current === "visiting") {
        throw new Error(`Orchestration graph contains a cycle involving ${node.id}.`);
      }

      state.set(node.id, "visiting");
      for (const dependencyId of node.dependsOn ?? []) {
        const dependency = this.commandNodesById.get(dependencyId);
        if (!dependency) {
          throw new Error(`Orchestration node ${node.id} depends on unknown node ${dependencyId}.`);
        }
        visit(dependency);
      }
      state.set(node.id, "visited");
      ordered.push(node);
    };

    for (const node of this.commandNodes) visit(node);
    return ordered;
  }
}
