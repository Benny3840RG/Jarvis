import type { ReadlineAdapter } from "../cli.js";

export class NonBlankReadline implements ReadlineAdapter {
  constructor(private readonly delegate: ReadlineAdapter) {}

  async question(prompt: string): Promise<string> {
    while (true) {
      const answer = await this.delegate.question(prompt);
      if (answer.trim().length > 0) return answer;
    }
  }

  close(): void {
    this.delegate.close();
  }
}
