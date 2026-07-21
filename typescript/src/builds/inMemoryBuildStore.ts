import { applyBuildUpdate, cloneBuild, createBuild } from "./buildData.js";
import type { Build, BuildInput, BuildStore, BuildUpdate } from "./build.js";

/** In-memory BuildStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryBuildStore implements BuildStore {
  private readonly builds = new Map<string, Build>();

  list(): Promise<Build[]> {
    return Promise.resolve([...this.builds.values()].map(cloneBuild));
  }

  get(id: string): Promise<Build | null> {
    const build = this.builds.get(id);
    return Promise.resolve(build ? cloneBuild(build) : null);
  }

  add(input: BuildInput): Promise<Build> {
    let build: Build;
    try {
      build = createBuild(input);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.builds.set(build.id, build);
    return Promise.resolve(cloneBuild(build));
  }

  update(id: string, update: BuildUpdate): Promise<Build | null> {
    const build = this.builds.get(id);
    if (!build) return Promise.resolve(null);
    try {
      applyBuildUpdate(build, update);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(cloneBuild(build));
  }

  remove(id: string): Promise<Build | null> {
    const build = this.builds.get(id);
    if (!build) return Promise.resolve(null);
    this.builds.delete(id);
    return Promise.resolve(cloneBuild(build));
  }
}
