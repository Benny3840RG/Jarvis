import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import runCli from "../src/cli.js";
import type { PersistenceProvider, AssistantState } from "../src/persistence/persistence.js";

class MockPersistence implements PersistenceProvider {
  loadCalled = 0;
  saveCalled = 0;
  lastSaved: AssistantState | null = null;
  initial: AssistantState;
  constructor(initial: AssistantState = {}) {
    this.initial = initial;
  }
  async loadState() {
    this.loadCalled++;
    return this.initial;
  }
  async saveState(state: AssistantState) {
    this.saveCalled++;
    this.lastSaved = state;
  }
}

describe("CLI persistence wiring", () => {
  let out: string[];
  let err: string[];
  let exitCode: number | null;
  let mock: MockPersistence;

  beforeEach(() => {
    out = [];
    err = [];
    exitCode = null;
    mock = new MockPersistence({});
  });

  it("creates one provider and calls loadState once", async () => {
    await runCli(["status"], {
      persistence: mock,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      exit: (c) => { exitCode = c; },
    });
    assert.equal(mock.loadCalled, 1);
    assert.equal(mock.saveCalled, 1); // status saves state
    assert(out.some((s) => s.includes("Jarvis is working")));
  });

  it("restores loaded state and persists after note", async () => {
    const initial = { lastIntent: "greeting", notes: ["old"] } as AssistantState;
    mock = new MockPersistence(initial);
    await runCli(["note", "new note"], {
      persistence: mock,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      exit: (c) => { exitCode = c; },
    });
    assert.equal(mock.loadCalled, 1);
    assert.equal(mock.saveCalled, 1);
    assert(mock.lastSaved !== null);
    assert(Array.isArray((mock.lastSaved as any).notes));
    assert.equal(((mock.lastSaved as any).notes.length), 2);
  });

  it("saves reminders through provider", async () => {
    await runCli(["add-reminder", "Pay rent"], {
      persistence: mock,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      exit: (c) => { exitCode = c; },
    });
    assert.equal(mock.saveCalled, 1);
    assert((mock.lastSaved as any).lastReminder);
    assert.equal((mock.lastSaved as any).lastReminder.title, "Pay rent");
  });

  it("surfaces save failures", async () => {
    const failing = new (class implements PersistenceProvider {
      async loadState() { return {}; }
      async saveState() { throw new Error("disk full"); }
    })();

    let capturedErr: string[] = [];
    let capturedOut: string[] = [];
    let code: number | null = null;
    try {
      await runCli(["note", "x"], {
        persistence: failing,
        stdout: (s) => capturedOut.push(s),
        stderr: (s) => capturedErr.push(s),
        exit: (c) => { code = c; },
      });
    } catch (e) {
      // runCli will throw after save failure
    }
    assert(capturedErr.some((s) => s.includes("Failed to save persistent state")));
  });
});
