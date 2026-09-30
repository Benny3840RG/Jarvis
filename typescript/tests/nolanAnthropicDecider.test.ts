import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAnthropicDecider,
  createAnthropicDeciderFromEnv,
  resolveAnthropicWorkerConfigFromEnv,
  type AnthropicMessagesLike,
  type AnthropicWorkerConfig,
} from "../src/acp/nolanAnthropicDecider.js";
import type { AcpPermissionDecision } from "../src/acp/acpContract.js";
import type { AcpPermissionRequest } from "../src/acp/acpTransport.js";

const REQUEST: AcpPermissionRequest = Object.freeze({
  requestId: "req-1",
  action: "github:merge-pull-request",
  detail: "corr-1",
});

const CONFIG: AnthropicWorkerConfig = Object.freeze({
  apiKey: "sk-ant-test-not-real",
  model: "claude-opus-5",
  timeoutMs: 5_000,
});

function fakeClient(
  respond: (params: unknown) => {
    stop_reason: string | null;
    parsed_output?: { decision: AcpPermissionDecision; reason: string } | null;
  },
): AnthropicMessagesLike {
  return {
    async parse(params) {
      return respond(params);
    },
  };
}

describe("resolveAnthropicWorkerConfigFromEnv", () => {
  it("is dormant (null) when no credential is configured", () => {
    assert.equal(resolveAnthropicWorkerConfigFromEnv({}), null);
  });

  it("is dormant when CREDENTIALS_DIRECTORY is set but the credential name is missing", () => {
    assert.equal(
      resolveAnthropicWorkerConfigFromEnv({ CREDENTIALS_DIRECTORY: "/run/credentials/x" }),
      null,
    );
  });

  it("rejects a credential name that escapes the credentials directory", () => {
    assert.equal(
      resolveAnthropicWorkerConfigFromEnv({
        CREDENTIALS_DIRECTORY: "/run/credentials/x",
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "../../etc/passwd",
      }),
      null,
    );
  });

  it("is dormant when the credential file cannot be read", () => {
    assert.equal(
      resolveAnthropicWorkerConfigFromEnv({
        CREDENTIALS_DIRECTORY: "/nonexistent-dir-xyz",
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "anthropic-key",
      }),
      null,
    );
  });

  it("resolves a full config from a real credential file, with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-anthropic-cred-"));
    try {
      writeFileSync(join(dir, "anthropic-key"), "sk-ant-real-looking-key\n");
      const config = resolveAnthropicWorkerConfigFromEnv({
        CREDENTIALS_DIRECTORY: dir,
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "anthropic-key",
      });
      assert.deepEqual(config, {
        apiKey: "sk-ant-real-looking-key",
        model: "claude-opus-5",
        timeoutMs: 20_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours an overridden model, timeout, and proxy URI", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-anthropic-cred-"));
    try {
      writeFileSync(join(dir, "anthropic-key"), "sk-ant-real-looking-key");
      const config = resolveAnthropicWorkerConfigFromEnv({
        CREDENTIALS_DIRECTORY: dir,
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "anthropic-key",
        JARVIS_ACP_ANTHROPIC_MODEL: "claude-haiku-4-5",
        JARVIS_ACP_ANTHROPIC_TIMEOUT_MS: "9000",
        JARVIS_ACP_ANTHROPIC_PROXY_URI: "http://127.0.0.1:8091",
      });
      assert.deepEqual(config, {
        apiKey: "sk-ant-real-looking-key",
        model: "claude-haiku-4-5",
        timeoutMs: 9000,
        proxyUri: "http://127.0.0.1:8091",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is dormant when the timeout override is not a positive integer", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-anthropic-cred-"));
    try {
      writeFileSync(join(dir, "anthropic-key"), "sk-ant-real-looking-key");
      assert.equal(
        resolveAnthropicWorkerConfigFromEnv({
          CREDENTIALS_DIRECTORY: dir,
          JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "anthropic-key",
          JARVIS_ACP_ANTHROPIC_TIMEOUT_MS: "not-a-number",
        }),
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createAnthropicDecider — never fabricates a decision", () => {
  it("returns the model's decision on a valid, non-refused, schema-conforming response", async () => {
    for (const decision of ["allow", "deny", "abstain"] as const) {
      const decider = createAnthropicDecider(CONFIG, {
        client: fakeClient(() => ({
          stop_reason: "end_turn",
          parsed_output: { decision, reason: "bounded reason" },
        })),
      });
      assert.equal(await decider(REQUEST), decision);
    }
  });

  it("throws on a safety refusal rather than returning a decision", async () => {
    const decider = createAnthropicDecider(CONFIG, {
      client: fakeClient(() => ({ stop_reason: "refusal", parsed_output: null })),
    });
    await assert.rejects(async () => {
      await decider(REQUEST);
    }, /refused/);
  });

  it("throws on a non-end_turn stop reason even when parsed_output is present (fail-closed)", async () => {
    // An incomplete/abnormal completion (truncation, a paused/tool turn) is not
    // a decision, even if a `parsed_output` happens to be attached.
    for (const stop_reason of [
      "max_tokens",
      "tool_use",
      "pause_turn",
      "model_context_window_exceeded",
    ]) {
      const decider = createAnthropicDecider(CONFIG, {
        client: fakeClient(() => ({
          stop_reason,
          parsed_output: { decision: "allow", reason: "bounded reason" },
        })),
      });
      await assert.rejects(
        async () => {
          await decider(REQUEST);
        },
        new RegExp(`unexpected stop_reason ${stop_reason}`),
      );
    }
  });

  it("throws on a null stop reason even when parsed_output is present (fail-closed)", async () => {
    const decider = createAnthropicDecider(CONFIG, {
      client: fakeClient(() => ({
        stop_reason: null,
        parsed_output: { decision: "allow", reason: "bounded reason" },
      })),
    });
    await assert.rejects(async () => {
      await decider(REQUEST);
    }, /unexpected stop_reason null/);
  });

  it("throws when parsed_output is null (schema mismatch)", async () => {
    const decider = createAnthropicDecider(CONFIG, {
      client: fakeClient(() => ({ stop_reason: "end_turn", parsed_output: null })),
    });
    await assert.rejects(async () => {
      await decider(REQUEST);
    }, /did not parse/);
  });

  it("throws when parsed_output is absent entirely", async () => {
    const decider = createAnthropicDecider(CONFIG, {
      client: fakeClient(() => ({ stop_reason: "end_turn" })),
    });
    await assert.rejects(async () => {
      await decider(REQUEST);
    }, /did not parse/);
  });

  it("propagates a transport-level rejection (network error) as a throw", async () => {
    const decider = createAnthropicDecider(CONFIG, {
      client: {
        async parse() {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    await assert.rejects(async () => {
      await decider(REQUEST);
    }, /ECONNREFUSED/);
  });

  it("passes the configured model, timeout, and bounded request content", async () => {
    let seenParams: Record<string, unknown> | undefined;
    let seenOptions: { timeout?: number } | undefined;
    const decider = createAnthropicDecider(CONFIG, {
      client: {
        async parse(params, options) {
          seenParams = params as unknown as Record<string, unknown>;
          seenOptions = options;
          return { stop_reason: "end_turn", parsed_output: { decision: "abstain", reason: "x" } };
        },
      },
    });
    await decider(REQUEST);
    assert.equal(seenParams?.model, "claude-opus-5");
    assert.equal(seenOptions?.timeout, 5_000);
    const messages = seenParams?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]?.content.includes("github:merge-pull-request"), true);
    assert.equal(messages[0]?.content.includes("req-1"), true);
  });
});

describe("createAnthropicDeciderFromEnv", () => {
  it("is dormant (null) when no credential is configured", () => {
    assert.equal(createAnthropicDeciderFromEnv({}), null);
  });

  it("returns a decider function when a credential is configured (never invoked here)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-anthropic-cred-"));
    try {
      writeFileSync(join(dir, "anthropic-key"), "sk-ant-real-looking-key");
      const decider = createAnthropicDeciderFromEnv({
        CREDENTIALS_DIRECTORY: dir,
        JARVIS_ACP_ANTHROPIC_API_KEY_CREDENTIAL: "anthropic-key",
      });
      assert.equal(typeof decider, "function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
