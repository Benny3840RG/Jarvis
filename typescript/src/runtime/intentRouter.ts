import type { Intent } from "./conversationService.js";
import { classifyIntent } from "./intentClassifier.js";

export class IntentRouter {
  route(text: string): Intent {
    return classifyIntent(text);
  }
}
