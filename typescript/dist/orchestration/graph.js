export class OrchestrationGraph {
    nodes = [];
    edges = [];
    addNode(node) {
        this.nodes.push(node);
    }
    addEdge(edge) {
        this.edges.push(edge);
    }
    getPlan() {
        return { nodes: this.nodes, edges: this.edges };
    }
}
