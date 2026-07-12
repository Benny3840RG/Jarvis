import assert from "node:assert/strict";
import { describe, it } from "node:test";

import runCli, { type ReadlineAdapter } from "../src/cli.js";
import type {
  AssistantState,
  PersistenceProvider,
} from "../src/persistence/persistence.js";

class ScriptedReadline implements ReadlineAdapter {
  readonly prompts: string[] = [];
  closed = false;

  constructor(private readonly inputs: string[]) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.inputs.shift() ?? "exit";
  }

  close(): void {
    this.closed = true;
  }
}

class MockPersistence implements PersistenceProvider {
  loadCalled = 0;
  saveCalled = 0;
  lastSaved: AssistantState | null = null;

  constructor(private readonly initial: AssistantState = {}) {}

  async loadState(): Promise<AssistantState> {
    this.loadCalled += 1;
    return { ...this.initial };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.saveCalled += 1;
    this.lastSaved = state;
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

describe("interactive CLI persistence wiring", () => {
  it("loads state once and exits through the original readline loop", async () => {
    const persistence = new MockPersistence({ existing: "kept" });
    const readline = new ScriptedReadline(["exit"]);
    const output: string[] = [];

    await runCli({
      persistence,
      readline,
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.equal(persistence.loadCalled, 1);
    assert.equal(persistence.saveCalled, 0);
    assert.equal(readline.prompts.length, 1);
    assert.equal(readline.prompts[0], "You: ");
    assert.equal(readline.closed, true);
    assert(output.some((line) => line.includes("Jarvis CLI ready")));
  });

  it("persists reminders before printing success", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline([
      "remind me to buy milk",
      "exit",
    ]);
    const output: string[] = [];

    await runCli({
      persistence,
      readline,
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.equal(persistence.saveCalled, 1);
    assert.notEqual(persistence.lastSaved, null);
    const reminder = record(persistence.lastSaved?.lastReminder);
    assert.equal(reminder.title, "remind me to buy milk");
    assert.equal(reminder.due, "tomorrow");
    assert(output.some((line) => line.includes("Reminder set:")));
  });

  it("persists tasks through the same provider", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline([
      "add workshop task",
      "exit",
    ]);

    await runCli({ persistence, readline, stdout: () => undefined });

    assert.equal(persistence.saveCalled, 1);
    assert.notEqual(persistence.lastSaved, null);
    const task = record(persistence.lastSaved?.lastTask);
    assert.equal(task.title, "add workshop task");
    assert.equal(task.category, "personal");
  });

  it("restores prior state and persists general conversation fields", async () => {
    const persistence = new MockPersistence({ retained: "yes" });
    const readline = new ScriptedReadline(["hello Jarvis", "exit"]);

    await runCli({ persistence, readline, stdout: () => undefined });

    assert.notEqual(persistence.lastSaved, null);
    assert.equal(persistence.lastSaved?.retained, "yes");
    assert.equal(persistence.lastSaved?.lastInput, "hello Jarvis");
    assert.equal(persistence.lastSaved?.lastIntent, "greeting");
    assert.notEqual(persistence.lastSaved?.lastResult, undefined);
  });

  it("surfaces save failures and does not print a false success", async () => {
    const persistence: PersistenceProvider = {
      async loadState(): Promise<AssistantState> {
        return {};
      },
      async saveState(): Promise<void> {
        throw new Error("disk full");
      },
    };
    const readline = new ScriptedReadline([
      "remind me to buy milk",
      "exit",
    ]);
    const output: string[] = [];
    const errors: string[] = [];

    await assert.rejects(
      runCli({
        persistence,
        readline,
        stdout: (...values) => output.push(values.join(" ")),
        stderr: (...values) => errors.push(values.join(" ")),
      }),
      /disk full/,
    );

    assert(errors.some((line) => line.includes("Failed to save persistent state")));
    assert.equal(output.some((line) => line.includes("Reminder set:")), false);
    assert.equal(readline.closed, true);
  });
});
