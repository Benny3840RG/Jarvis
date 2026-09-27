import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAcpWorkerConfigFromEnv } from "../src/acp/acpWorkerConfig.js";

describe("ACP worker config resolution (PR H, slice 4)", () => {
  it("resolves a command and JSON-array args", () => {
    const config = resolveAcpWorkerConfigFromEnv({
      JARVIS_ACP_WORKER_COMMAND: "claude",
      JARVIS_ACP_WORKER_ARGS: '["acp","--stdio"]',
    });
    assert.deepEqual(config, { command: "claude", args: ["acp", "--stdio"] });
  });

  it("defaults args to an empty list when the args var is absent", () => {
    const config = resolveAcpWorkerConfigFromEnv({ JARVIS_ACP_WORKER_COMMAND: "codex" });
    assert.deepEqual(config, { command: "codex", args: [] });
  });

  it("supports a custom env prefix (so multiple workers can be configured)", () => {
    const claude = resolveAcpWorkerConfigFromEnv(
      {
        JARVIS_ACP_CLAUDE_COMMAND: "claude",
        JARVIS_ACP_CLAUDE_ARGS: '["acp"]',
        JARVIS_ACP_CODEX_COMMAND: "codex",
      },
      { prefix: "JARVIS_ACP_CLAUDE" },
    );
    assert.deepEqual(claude, { command: "claude", args: ["acp"] });
  });

  it("keeps args as literal argv (no shell splitting)", () => {
    const config = resolveAcpWorkerConfigFromEnv({
      JARVIS_ACP_WORKER_COMMAND: "claude",
      JARVIS_ACP_WORKER_ARGS: '["--flag","one two three"]',
    });
    // An arg containing spaces stays a single element — spawn passes argv, no shell.
    assert.deepEqual(config?.args, ["--flag", "one two three"]);
  });

  it("trims the command and rejects a blank one", () => {
    assert.deepEqual(resolveAcpWorkerConfigFromEnv({ JARVIS_ACP_WORKER_COMMAND: "  claude  " }), {
      command: "claude",
      args: [],
    });
    assert.equal(resolveAcpWorkerConfigFromEnv({ JARVIS_ACP_WORKER_COMMAND: "   " }), null);
  });

  it("fails closed when the command is missing or the args are malformed", () => {
    // Missing command.
    assert.equal(resolveAcpWorkerConfigFromEnv({}), null);
    assert.equal(resolveAcpWorkerConfigFromEnv({ JARVIS_ACP_WORKER_ARGS: '["acp"]' }), null);
    const base = { JARVIS_ACP_WORKER_COMMAND: "claude" };
    // Args present but not valid JSON / not an array / non-string elements.
    for (const args of ["not json", "{}", '"acp"', "42", "[1,2]", '["ok",3]', "[null]"]) {
      assert.equal(
        resolveAcpWorkerConfigFromEnv({ ...base, JARVIS_ACP_WORKER_ARGS: args }),
        null,
        args,
      );
    }
  });

  it("accepts an explicit empty args array", () => {
    assert.deepEqual(
      resolveAcpWorkerConfigFromEnv({
        JARVIS_ACP_WORKER_COMMAND: "claude",
        JARVIS_ACP_WORKER_ARGS: "[]",
      }),
      { command: "claude", args: [] },
    );
  });
});
