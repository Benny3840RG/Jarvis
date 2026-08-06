import type { DomainEngine } from "./domainRouter.js";
import {
  InMemoryDomainStateStore,
  type DomainScene,
  type DomainStateStore,
} from "./domainState.js";
import { asString, type Payload } from "./types.js";

export class HomeEngine implements DomainEngine {
  constructor(private readonly store: DomainStateStore = new InMemoryDomainStateStore()) {}

  handle(action: string, payload: Payload): Promise<unknown> {
    return this.dispatch(action, payload);
  }

  private async dispatch(action: string, payload: Payload): Promise<unknown> {
    switch (action) {
      case "list_scenes":
        return (await this.store.load()).home.scenes;
      case "activate_scene":
        return this.activateScene(asString(payload.sceneName));
      default:
        return { error: `Unknown home action: ${action}` };
    }
  }

  private async activateScene(sceneName: string): Promise<unknown> {
    let sceneResult: DomainScene | undefined;
    await this.store.update((state) => {
      const scene = state.home.scenes.find((candidate) => candidate.name === sceneName);
      if (!scene) return;
      state.home.activeScene = scene.name;
      sceneResult = scene;
    });
    if (!sceneResult) return { error: "Scene not found" };
    return { activated: sceneResult.name, description: sceneResult.description };
  }
}
