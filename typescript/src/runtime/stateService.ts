export class StateService {
  private readonly state: Record<string, unknown> = {};

  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  replace(nextState: Record<string, unknown>): void {
    for (const key of Object.keys(this.state)) delete this.state[key];
    Object.assign(this.state, nextState);
  }

  get(key: string): unknown {
    return this.state[key];
  }

  snapshot(): Record<string, unknown> {
    return { ...this.state };
  }
}
