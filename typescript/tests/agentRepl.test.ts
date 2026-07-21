import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAgentRepl, type ReplIo } from "../src/agent/repl.js";

class ScriptedIo implements ReplIo {
  closed = false;

  constructor(private readonly lines: string[]) {}

  question(): Promise<string> {
    return Promise.resolve(this.lines.shift() ?? "exit");
  }

  close(): void {
    this.closed = true;
  }
}

function capture() {
  const output: string[] = [];
  return { output, write: (line: string) => output.push(line) };
}

describe("agent REPL", () => {
  it("processes an utterance and echoes intent, safety, and prediction", async () => {
    const io = new ScriptedIo(["start job j1", "exit"]);
    const { output, write } = capture();

    await runAgentRepl(io, write);

    assert.equal(io.closed, true);
    const result = output.map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    const turn = result.find((entry) => entry && entry.intent === "start_job");
    assert.ok(turn, "expected a turn for start_job");
    assert.deepEqual(turn?.entities, { jobId: "j1" });
    assert.equal(turn?.predictedNextIntent, "prepare_job");
  });

  it("supports help, snapshot, blank lines, and quit", async () => {
    const io = new ScriptedIo(["", "help", "snapshot", "quit"]);
    const { output, write } = capture();

    await runAgentRepl(io, write);

    assert.ok(output.some((line) => line.includes("Commands:")));
    assert.ok(output.some((line) => line.includes('"stats"') && line.includes('"memory"')));
    assert.equal(io.closed, true);
  });
});
