import { createAgentSystem, type AgentSystem } from "./system.js";

/** Minimal line-reader abstraction so the REPL can be driven by a real terminal or a test. */
export interface ReplIo {
  question(prompt: string): Promise<string>;
  close(): void;
}

const HELP = [
  "Commands:",
  '  <utterance>   e.g. "start job j1", "prepare job j1", "complete job j1"',
  "  snapshot      show learning stats and a memory snapshot",
  "  help          show this help",
  "  exit | quit   leave the session",
].join("\n");

/**
 * Runs an interactive session over a single in-memory agent system. Each
 * utterance is parsed, planned, executed, learned from, and echoed back with its
 * safety result and predicted next intent. State lives only for the session.
 */
export async function runAgentRepl(
  io: ReplIo,
  write: (line: string) => void,
  system: AgentSystem = createAgentSystem(),
): Promise<void> {
  write('Jarvis agent ready. Type "help", an utterance, or "exit".');

  try {
    for (;;) {
      const input = (await io.question("agent> ")).trim();
      if (input === "") continue;
      if (input === "exit" || input === "quit") break;
      if (input === "help") {
        write(HELP);
        continue;
      }
      if (input === "snapshot") {
        write(
          JSON.stringify(
            { stats: system.learning.getStats(), memory: system.memoryManager.snapshot() },
            null,
            2,
          ),
        );
        continue;
      }

      try {
        const parsed = system.conversation.parse(input);
        const execution = await system.orchestrator.execute(system.orchestrator.plan(parsed));
        system.learning.record(parsed.intent, execution.safety.status === "ok");
        system.memoryManager.addShortTerm(parsed.intent, parsed.entities);

        write(
          JSON.stringify(
            {
              intent: parsed.intent,
              entities: parsed.entities,
              safety: execution.safety,
              outputs: execution.outputs,
              predictedNextIntent: system.prediction.predictNextIntent(
                system.learning.getHistory(),
              ),
            },
            null,
            2,
          ),
        );
      } catch (error: unknown) {
        write(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    io.close();
  }
}
