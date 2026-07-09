import { runCli } from "./cli.js";
async function main() {
    await runCli();
}
main().catch(console.error);
