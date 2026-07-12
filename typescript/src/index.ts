import { runCli } from "./cli.js";

async function main(): Promise<void> {
  await runCli();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
