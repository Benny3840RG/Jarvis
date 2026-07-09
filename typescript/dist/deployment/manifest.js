export class DeploymentManifestBuilder {
    build(name) {
        return {
            name,
            runtime: "node",
            entrypoint: "src/index.ts",
        };
    }
}
