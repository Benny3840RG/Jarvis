import type { OrchestrationCommand } from "./contracts.js";

export type GraphNode = { id: string; kind: string };
export type GraphEdge = { from: string; to: string };

export type OrchestrationNode = {
  id: string;
  command: OrchestrationCommand;
  dependsOn?: readonly string[];
  /** Higher-weight ready nodes are selected first; ties retain declaration order. */
  weight?: number;
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
      if (
        node.weight !== undefined &&
        (!Number.isFinite(node.weight) || node.weight < 0)
      ) {
        throw new Error(`Orchestration node ${node.id} has an invalid weight.`);
      }
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
    const declarationOrder = new Map(
      this.commandNodes.map((node, index) => [node.id, index]),
    );
    const dependents = new Map<string, string[]>();
    const remainingDependencies = new Map<string, number>();

    for (const node of this.commandNodes) {
      const dependencies = node.dependsOn ?? [];
      remainingDependencies.set(node.id, dependencies.length);
      for (const dependencyId of dependencies) {
        const dependentsForNode = dependents.get(dependencyId) ?? [];
        dependentsForNode.push(node.id);
        dependents.set(dependencyId, dependentsForNode);
      }
    }

    const ready = this.commandNodes
      .filter((node) => (node.dependsOn ?? []).length === 0)
      .map((node) => node.id);
    const sortReady = (): void => {
      ready.sort((leftId, rightId) => {
        const left = this.commandNodesById.get(leftId);
        const right = this.commandNodesById.get(rightId);
        const weightDifference = (right?.weight ?? 0) - (left?.weight ?? 0);
        return (
          weightDifference ||
          (declarationOrder.get(leftId) ?? 0) -
            (declarationOrder.get(rightId) ?? 0)
        );
      });
    };

    const ordered: OrchestrationNode[] = [];
    while (ready.length > 0) {
      sortReady();
      const nodeId = ready.shift();
      if (nodeId === undefined) continue;
      const node = this.commandNodesById.get(nodeId);
      if (!node) continue;
      ordered.push(node);

      for (const dependentId of dependents.get(nodeId) ?? []) {
        const remaining = (remainingDependencies.get(dependentId) ?? 0) - 1;
        remainingDependencies.set(dependentId, remaining);
        if (remaining === 0) ready.push(dependentId);
      }
    }

    if (ordered.length !== this.commandNodes.length) {
      const unresolved = this.commandNodes.find(
        (node) => !ordered.some((item) => item.id === node.id),
      );
      throw new Error(
        `Orchestration graph contains a cycle involving ${unresolved?.id ?? "unknown"}.`,
      );
    }

    return ordered;
  }
}
