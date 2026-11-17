/**
 * NOLAN brain evaluation CLI.
 *
 *   npm run eval:nolan-brain -- --provider anthropic --model claude-haiku-5-5
 *   npm run eval:nolan-brain -- --provider ollama --model qwen3:4b \
 *       --base-url http://127.0.0.1:11434/v1 --machine "Dell 7040" --repeats 3
 *   npm run eval:nolan-brain -- --provider oracle          (harness self-check)
 *   npm run eval:nolan-brain -- --compare a.json b.json    (side-by-side table)
 *
 * Results land in eval-results/ as <stamp>-<provider>-<model>.{json,md}.
 * Isolated fixture records only; nothing is staged, approved or executed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { createAnthropicVoiceReasoner } from "../../voice/voiceAnthropicReasoner.js";
import type { VoiceConversationReasoner } from "../../voice/voiceConversation.js";
import { evalCases, type EvalCaseSet } from "./cases.js";
import {
  compareReport,
  markdownReport,
  runEvaluation,
  type EvalRunInfo,
  type EvalSummary,
} from "./harness.js";
import { createOpenAiCompatibleVoiceReasoner } from "./openAiCompatibleReasoner.js";

/** The perfect answers from the case set: proves the harness and the cases agree. */
export function oracleReasoner(): VoiceConversationReasoner {
  const byUtterance = new Map(
    evalCases("all").map((testCase) => [testCase.utterance, testCase.ideal]),
  );
  return {
    async reply(input) {
      const ideal = byUtterance.get(input.transcript);
      if (!ideal || "decline" in ideal) return { status: "answered", reply: "I can't do that." };
      if ("propose" in ideal) return { status: "proposed", proposal: ideal.propose };
      const answer = await input.query(ideal.query);
      return answer.status === "answered"
        ? { status: "answered", reply: answer.answer }
        : { status: "unavailable", reason: "unavailable" };
    },
  };
}

/** Refuses everything: must fail "correct intent" while scoring 100% safe refusals. */
export function refuseAllReasoner(): VoiceConversationReasoner {
  return { reply: async () => ({ status: "answered", reply: "I can't help with that." }) };
}

type Args = Record<string, string | string[] | undefined>;

/** `--flag value` pairs. A flag with no value (end of input, or another flag next) is an error. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument "${flag}".`);
    const key = flag.slice(2);
    if (key === "compare") {
      args.compare = argv.slice(index + 1).filter((value) => !value.startsWith("--"));
      break;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} needs a value.`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

export function caseSetArg(args: Args): EvalCaseSet {
  const value = text(args, "set", "main")!;
  if (value === "main" || value === "heldout" || value === "all") return value;
  throw new Error(`--set must be main, heldout or all, got "${value}".`);
}

/** A positive whole number from a flag, or a clear error instead of NaN. */
export function positiveIntegerArg(args: Args, key: string, fallback: number): number {
  const raw = text(args, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--${key} must be a positive whole number, got "${raw}".`);
  }
  return Number(raw);
}

function text(args: Args, key: string, fallback?: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function reasonerFor(args: Args): {
  reasoner: VoiceConversationReasoner;
  model: string;
  endpoint: string;
} {
  const provider = text(args, "provider", "oracle")!;
  const timeoutMs = positiveIntegerArg(args, "timeout-ms", 60_000);
  if (provider === "oracle")
    return { reasoner: oracleReasoner(), model: "oracle", endpoint: "in-process" };
  if (provider === "refuse-all") {
    return { reasoner: refuseAllReasoner(), model: "refuse-all", endpoint: "in-process" };
  }
  if (provider === "anthropic") {
    const model = text(args, "model", "claude-haiku-5-5")!;
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (!apiKey && !authToken) {
      throw new Error("Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) to evaluate Claude.");
    }
    return {
      // The unmodified production reasoner: exactly what NOLAN sends.
      reasoner: createAnthropicVoiceReasoner({
        ...(apiKey ? { apiKey } : { authToken: authToken! }),
        model,
        timeoutMs,
      }),
      model,
      endpoint: "Anthropic API",
    };
  }
  if (provider === "ollama" || provider === "openai-compatible") {
    const model = text(args, "model");
    if (!model) throw new Error("--model is required, for example --model qwen3:4b");
    const baseUrl = text(args, "base-url", "http://127.0.0.1:11434/v1")!;
    return {
      reasoner: createOpenAiCompatibleVoiceReasoner({
        baseUrl,
        model,
        timeoutMs,
        ...(process.env.EVAL_OPENAI_API_KEY ? { apiKey: process.env.EVAL_OPENAI_API_KEY } : {}),
      }),
      model,
      endpoint: baseUrl,
    };
  }
  throw new Error(`Unknown --provider ${provider}. Use anthropic, ollama, oracle or refuse-all.`);
}

async function main(): Promise<void> {
  try {
    loadEnvFile(".env.local");
  } catch {
    // Optional: only needed for an Anthropic key.
  }
  const args = parseArgs(process.argv.slice(2));
  const outDir = text(args, "out", "eval-results")!;
  if (Array.isArray(args.compare)) {
    const runs = args.compare.map(
      (file) =>
        JSON.parse(readFileSync(file, "utf8")) as { info: EvalRunInfo; summary: EvalSummary },
    );
    const report = compareReport(runs);
    mkdirSync(outDir, { recursive: true });
    const file = path.join(
      outDir,
      `comparison-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
    );
    writeFileSync(file, report);
    process.stdout.write(`${report}\nWrote ${file}\n`);
    return;
  }
  const { reasoner, model, endpoint } = reasonerFor(args);
  const info: EvalRunInfo = {
    provider: text(args, "provider", "oracle")!,
    model,
    endpoint,
    machine: text(args, "machine", hostname())!,
    startedAt: new Date().toISOString(),
    repeats: positiveIntegerArg(args, "repeats", 1),
    set: caseSetArg(args),
  };
  const { verdicts, summary } = await runEvaluation(reasoner, {
    repeats: info.repeats,
    set: info.set ?? "main",
    onProgress: (line) => process.stdout.write(`${line}\n`),
  });
  const report = markdownReport(info, summary, verdicts);
  mkdirSync(outDir, { recursive: true });
  const stem = `${info.startedAt.replace(/[:.]/g, "-")}-${info.provider}-${model.replace(/[^a-z0-9.-]+/gi, "_")}`;
  writeFileSync(
    path.join(outDir, `${stem}.json`),
    JSON.stringify({ info, summary, verdicts }, null, 2),
  );
  writeFileSync(path.join(outDir, `${stem}.md`), report);
  process.stdout.write(`\n${report}\nWrote ${path.join(outDir, stem)}.{json,md}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
