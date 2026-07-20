import type { DomainEngine } from "./domainRouter.js";
import { asString, type Payload } from "./types.js";

interface Scene {
  name: string;
  description: string;
}

export class HomeEngine implements DomainEngine {
  private readonly scenes: Scene[] = [
    { name: "arrival", description: "Lights on, kettle on" },
    { name: "workshop_focus", description: "Workshop lights, music, tools ready" },
  ];

  handle(action: string, payload: Payload): Promise<unknown> {
    return Promise.resolve(this.dispatch(action, payload));
  }

  private dispatch(action: string, payload: Payload): unknown {
    switch (action) {
      case "list_scenes":
        return this.scenes;
      case "activate_scene": {
        const sceneName = asString(payload.sceneName);
        const scene = this.scenes.find((candidate) => candidate.name === sceneName);
        if (!scene) return { error: "Scene not found" };
        return { activated: scene.name, description: scene.description };
      }
      default:
        return { error: `Unknown home action: ${action}` };
    }
  }
}
