export class StateService {
  private readonly state: Record<string, unknown> = {};

  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  get(key: string): unknown {
    return this.state[key];
  }

  snapshot(): Record<string, unknown> {
    return { ...this.state };
  }
}
