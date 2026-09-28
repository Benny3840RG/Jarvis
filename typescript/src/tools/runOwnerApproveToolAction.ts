/**
 * Owner-operated ToolAction approval client. Run it yourself, in your own
 * interactive terminal, from the directory that holds `.env.local`:
 *
 *   npm run owner:approve -- --project <projectId> --action <actionId> --expect-file <expected.json>
 *
 * `expected.json` holds the complete envelope you expect: { tool, operation,
 * arguments, requiredAuthority, destructive }, all mandatory. Only `home:announce`
 * actions are supported.
 * The action is fetched, compared to it, shown to you, and only approved after
 * you type the confirmation phrase and then the owner approval token at a
 * hidden prompt. The token is never accepted from arguments, the environment
 * or a pipe, and this tool never executes the action.
 *
 * Reads `JARVIS_API_BASE_URL` (loopback only) and `JARVIS_SERVICE_TOKEN` from
 * `.env.local`. If `JARVIS_GOOGLE_HOME_TARGETS_JSON` is present it is used only
 * to display the pinned speaker address.
 */

import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  OwnerApprovalError,
  createHttpOwnerApprovalTransport,
  parseOwnerApprovalArgs,
  parseOwnerApprovalExpectation,
  readHiddenLine,
  runOwnerApproval,
  type OwnerApprovalIo,
} from "../actions/ownerToolActionApproval.js";
import { resolveJarvisMcpConfig } from "../mcp/config.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function pinnedAddressFromEnvironment(target: string): string | undefined {
  try {
    const map = JSON.parse(process.env.JARVIS_GOOGLE_HOME_TARGETS_JSON ?? "{}") as Record<
      string,
      unknown
    >;
    const address = map[target];
    return typeof address === "string" ? address : undefined;
  } catch {
    return undefined;
  }
}

function askVisible(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseOwnerApprovalArgs(argv);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new OwnerApprovalError(
      "not-interactive",
      "Owner approval requires an interactive terminal on stdin and stdout.",
    );
  }
  loadLocalEnvironment();
  const expectation = parseOwnerApprovalExpectation(readFileSync(args.expectFile, "utf8"));
  const api = resolveJarvisMcpConfig().api;
  const transport = createHttpOwnerApprovalTransport({
    baseUrl: api.baseUrl,
    serviceToken: api.serviceToken,
  });
  const io: OwnerApprovalIo = {
    write: (text) => process.stdout.write(`${text}\n`),
    confirm: askVisible,
    readSecret: (prompt) => readHiddenLine(prompt, process.stdin, process.stdout),
    pinnedAddress: pinnedAddressFromEnvironment,
  };
  await runOwnerApproval({
    projectId: args.projectId,
    actionId: args.actionId,
    expectation,
    transport,
    io,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    const code = error instanceof OwnerApprovalError ? ` [${error.code}]` : "";
    console.error(`Owner approval did not complete${code}: ${message}`);
    process.exitCode = error instanceof OwnerApprovalError && error.code === "cancelled" ? 2 : 1;
  });
}
