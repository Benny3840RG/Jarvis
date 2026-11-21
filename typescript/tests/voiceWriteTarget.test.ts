import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commissionVoiceProject,
  type VoiceProjectClient,
} from "../src/tools/runVoiceProjectCommissioning.js";
import {
  createVoiceWriteTargetFromEnv,
  DEFAULT_VOICE_PROJECT_KEY,
  resolveVoiceProjectKey,
  VOICE_PROJECT_UNREADABLE_REASON,
  VoiceWriteTarget,
} from "../src/voice/voiceWriteTarget.js";

function reader(value: number | null | Error) {
  return {
    async revision(): Promise<number | null> {
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("voice project key", () => {
  it("defaults to the dedicated NOLAN voice project", () => {
    assert.equal(resolveVoiceProjectKey({}), DEFAULT_VOICE_PROJECT_KEY);
    assert.equal(resolveVoiceProjectKey({ JARVIS_VOICE_PROJECT_KEY: "  " }), "nolan-voice");
  });

  it("accepts an owner-configured key", () => {
    assert.equal(resolveVoiceProjectKey({ JARVIS_VOICE_PROJECT_KEY: "shed-voice" }), "shed-voice");
  });

  it("refuses a key that is not a single lowercase token", () => {
    for (const bad of ["Shed Voice", "a/b", "-x", "x".repeat(65)]) {
      assert.throws(() => resolveVoiceProjectKey({ JARVIS_VOICE_PROJECT_KEY: bad }), bad);
    }
  });
});

describe("voice write target", () => {
  it("resolves the project with its current revision", async () => {
    const target = new VoiceWriteTarget("nolan-voice", reader(7));
    assert.deepEqual(await target.resolve(), { projectId: "nolan-voice", expectedRevision: 7 });
  });

  it("fails closed for a missing, unreadable or malformed project", async () => {
    const missing = await new VoiceWriteTarget("nolan-voice", reader(null)).resolve();
    assert.ok("reason" in missing);
    assert.match(missing.reason, /not commissioned/);

    for (const value of [new Error("down"), 0, -1, 1.5, Number.NaN]) {
      const resolved = await new VoiceWriteTarget("nolan-voice", reader(value)).resolve();
      assert.deepEqual(resolved, { reason: VOICE_PROJECT_UNREADABLE_REASON }, String(value));
    }
  });

  it("is absent unless tool actions are backed by Convex", () => {
    assert.equal(createVoiceWriteTargetFromEnv({ PERSISTENCE_PROVIDER: "json" }), null);
    assert.equal(createVoiceWriteTargetFromEnv({ PERSISTENCE_PROVIDER: "convex" }), null);
    const target = createVoiceWriteTargetFromEnv({
      PERSISTENCE_PROVIDER: "convex",
      CONVEX_URL: "https://example.convex.cloud",
      JARVIS_SERVICE_TOKEN: "token",
    });
    assert.equal(target?.projectKey, "nolan-voice");
  });
});

describe("voice project commissioning", () => {
  function fakeClient(existing: { revision: number } | null) {
    const created: Parameters<VoiceProjectClient["create"]>[0][] = [];
    const client: VoiceProjectClient = {
      async get() {
        return existing;
      },
      async create(input) {
        created.push(input);
        return { revision: input.revision };
      },
    };
    return { client, created };
  }

  it("creates the voice project at revision 1 when it is absent", async () => {
    const { client, created } = fakeClient(null);
    const result = await commissionVoiceProject({
      client,
      projectKey: "nolan-voice",
      now: () => new Date("2026-11-15T00:00:00.000Z"),
    });
    assert.deepEqual(result, { projectKey: "nolan-voice", revision: 1, created: true });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.projectKey, "nolan-voice");
    assert.equal(created[0]?.revision, 1);
    assert.equal(created[0]?.status, "active");
    assert.equal(created[0]?.createdAt, "2026-11-15T00:00:00.000Z");
  });

  it("never touches an existing voice project", async () => {
    const { client, created } = fakeClient({ revision: 4 });
    const result = await commissionVoiceProject({ client, projectKey: "nolan-voice" });
    assert.deepEqual(result, { projectKey: "nolan-voice", revision: 4, created: false });
    assert.equal(created.length, 0);
  });
});
