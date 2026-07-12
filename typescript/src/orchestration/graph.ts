export type GraphNode = { id: string; kind: string };
export type GraphEdge = { from: string; to: string };

export class OrchestrationGraph {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];

  addNode(node: GraphNode): void {
    this.nodes.push(node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
  }

  getPlan(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: [...this.nodes], edges: [...this.edges] };
  }
}
