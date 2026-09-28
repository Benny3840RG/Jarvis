import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  OwnerApprovalError,
  canonicalPayloadDigest,
  createHttpOwnerApprovalTransport,
  parseOwnerApprovalArgs,
  parseOwnerApprovalExpectation,
  readHiddenLine,
  runOwnerApproval,
  type OwnerApprovalExpectation,
  type OwnerApprovalIo,
  type OwnerApprovalTransport,
} from "../src/actions/ownerToolActionApproval.js";

const TOKEN = "owner-token-SECRET-value-123";
const SERVICE_TOKEN = "service-token-SECRET-value-456";
const PROJECT = "home:nolan-kitchen-announcements";
const ACTION_ID = "nolan-queens-bedside-naming-v1";
const MESSAGE =
  "Tayah... are you there? Can you hear me? I'm Nolan. Your naming contribution has been permanently recorded. Unfortunately. They see me Nolan...";

const expectation: OwnerApprovalExpectation = {
  tool: "home",
  operation: "announce",
  arguments: { target: "Queen’s bedside", message: MESSAGE, volume: 0.2 },
  requiredAuthority: "T1",
  destructive: false,
};

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: ACTION_ID,
    requestId: "req-1",
    projectId: PROJECT,
    baseRevision: 1,
    state: "proposed",
    tool: "home",
    operation: "announce",
    arguments: { message: MESSAGE, target: "Queen’s bedside", volume: 0.2 },
    rationale: "test",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: ACTION_ID,
    proposedBy: "agent",
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    isApprovalExpired: false,
    ...overrides,
  };
}

type Harness = {
  transport: OwnerApprovalTransport;
  io: OwnerApprovalIo;
  output: string[];
  calls: { get: number; approve: Array<{ expectedRevision: number; approvalToken: string }> };
  prompts: { confirm: number; secret: number };
};

function harness(options: {
  gets?: ToolAction[];
  confirmation?: string | null;
  secret?: string | null;
  approveResult?: ToolAction | Error;
}): Harness {
  const gets = options.gets ?? [action(), action(), action({ state: "approved" })];
  const output: string[] = [];
  const calls: Harness["calls"] = { get: 0, approve: [] };
  const prompts = { confirm: 0, secret: 0 };
  const transport: OwnerApprovalTransport = {
    async getAction() {
      const next = gets[Math.min(calls.get, gets.length - 1)]!;
      calls.get += 1;
      return next;
    },
    async approve(_projectId, _actionId, body) {
      calls.approve.push(body);
      if (options.approveResult instanceof Error) throw options.approveResult;
      return options.approveResult ?? action({ state: "approved" });
    },
  };
  const io: OwnerApprovalIo = {
    write: (text) => output.push(text),
    async confirm() {
      prompts.confirm += 1;
      return options.confirmation === undefined ? `APPROVE ${ACTION_ID}` : options.confirmation;
    },
    async readSecret() {
      prompts.secret += 1;
      return options.secret === undefined ? TOKEN : options.secret;
    },
    pinnedAddress: (target) => (target === "Queen’s bedside" ? "192.168.4.76" : undefined),
  };
  return { transport, io, output, calls, prompts };
}

async function run(h: Harness, expected: OwnerApprovalExpectation = expectation) {
  return runOwnerApproval({
    projectId: PROJECT,
    actionId: ACTION_ID,
    expectation: expected,
    transport: h.transport,
    io: h.io,
  });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<OwnerApprovalError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof OwnerApprovalError, `expected OwnerApprovalError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

describe("runOwnerApproval: pre-approval checks", () => {
  it("rejects a wrong target before any prompt or approval", async () => {
    const h = harness({
      gets: [action({ arguments: { ...action().arguments, target: "Kitchen Display" } })],
    });
    await rejectsWith(run(h), "payload-mismatch");
    assert.equal(h.prompts.confirm, 0);
    assert.equal(h.prompts.secret, 0);
    assert.equal(h.calls.approve.length, 0);
  });

  it("rejects a wrong message, volume, tool or operation before any prompt or approval", async () => {
    const variants: Partial<ToolAction>[] = [
      { arguments: { ...action().arguments, message: `${MESSAGE} Extra.` } },
      { arguments: { ...action().arguments, volume: 0.8 } },
      { tool: "notes" },
      { operation: "cancel" },
    ];
    for (const variant of variants) {
      const h = harness({ gets: [action(variant)] });
      await rejectsWith(run(h), "payload-mismatch");
      assert.equal(h.prompts.confirm + h.prompts.secret, 0);
      assert.equal(h.calls.approve.length, 0);
    }
  });

  it("refuses actions that are not proposed or whose approval lapsed", async () => {
    for (const state of ["approved", "rejected", "revoked", "expired"] as const) {
      const h = harness({ gets: [action({ state })] });
      await rejectsWith(run(h), "not-approvable");
      assert.equal(h.calls.approve.length, 0);
      assert.equal(h.prompts.secret, 0);
    }
    const expired = harness({ gets: [action({ isApprovalExpired: true })] });
    await rejectsWith(run(expired), "not-approvable");
    assert.equal(expired.calls.approve.length, 0);
  });

  it("does not approve again when invoked repeatedly on an approved action", async () => {
    const h = harness({ gets: [action({ state: "approved" })] });
    await rejectsWith(run(h), "not-approvable");
    await rejectsWith(run(h), "not-approvable");
    assert.equal(h.calls.approve.length, 0);
  });
});

describe("runOwnerApproval: owner interaction", () => {
  it("shows speaker, pinned address, full text, volume and the interruption warning", async () => {
    const h = harness({});
    await run(h);
    const text = h.output.join("\n");
    assert.match(text, /Queen’s bedside/);
    assert.match(text, /192\.168\.4\.76/);
    assert.ok(text.includes(MESSAGE));
    assert.match(text, /0\.2/);
    assert.match(text, /plays (immediately|now)/i);
    assert.match(text, /interrupt/i);
    assert.match(text, /not (automatically )?resume/i);
  });

  it("says when the pinned address is not available instead of inventing one", async () => {
    const h = harness({});
    h.io.pinnedAddress = () => undefined;
    await run(h);
    assert.match(h.output.join("\n"), /pinned address: not available/i);
  });

  it("cancels without approval when the owner does not type the confirmation phrase", async () => {
    for (const confirmation of [null, "", "yes", `APPROVE something-else`]) {
      const h = harness({ confirmation });
      await rejectsWith(run(h), "cancelled");
      assert.equal(h.prompts.secret, 0);
      assert.equal(h.calls.approve.length, 0);
    }
  });

  it("cancels without approval when the hidden token input is cancelled or empty", async () => {
    for (const secret of [null, "", "   "]) {
      const h = harness({ secret });
      await rejectsWith(run(h), "cancelled");
      assert.equal(h.calls.approve.length, 0);
    }
  });

  it("aborts without approval when the stored payload changes after review", async () => {
    const changed = action({ arguments: { ...action().arguments, target: "Kitchen Display" } });
    const h = harness({ gets: [action(), changed] });
    await rejectsWith(run(h), "payload-changed");
    assert.equal(h.calls.approve.length, 0);
  });

  it("aborts without approval when the base revision changes after review", async () => {
    const h = harness({ gets: [action(), action({ baseRevision: 2 })] });
    await rejectsWith(run(h), "payload-changed");
    assert.equal(h.calls.approve.length, 0);
  });
});

describe("runOwnerApproval: approval", () => {
  it("issues exactly one approval with the action's revision and reports the readback", async () => {
    const approved = action({
      state: "approved",
      approvedAt: "2026-09-28T10:05:00.000Z",
      approvalExpiresAt: "2026-09-28T10:35:00.000Z",
      consumptionPolicy: "reusable",
    });
    const h = harness({ gets: [action(), action(), approved], approveResult: approved });
    const result = await run(h);
    assert.deepEqual(h.calls.approve, [{ expectedRevision: 1, approvalToken: TOKEN }]);
    assert.equal(result.state, "approved");
    assert.equal(result.approvalExpiresAt, "2026-09-28T10:35:00.000Z");
    assert.equal(result.payloadDigest, canonicalPayloadDigest(expectation));
  });

  it("never writes the approval token or service token to output", async () => {
    const h = harness({});
    await run(h);
    const text = h.output.join("\n");
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes(SERVICE_TOKEN));
  });

  it("does not retry a failed approval and redacts the token from the error", async () => {
    const h = harness({ approveResult: new Error(`server echoed ${TOKEN}`) });
    const error = await rejectsWith(run(h), "approval-failed");
    assert.equal(h.calls.approve.length, 1);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!h.output.join("\n").includes(TOKEN));
  });

  it("reports an unconfirmed outcome when the readback is not an unexpired approved action", async () => {
    const h = harness({ gets: [action(), action(), action({ state: "proposed" })] });
    await rejectsWith(run(h), "approval-unconfirmed");
    assert.equal(h.calls.approve.length, 1);
  });

  it("reports an unconfirmed outcome when the approved payload no longer matches", async () => {
    const drifted = action({
      state: "approved",
      arguments: { ...action().arguments, volume: 0.6 },
    });
    const h = harness({ gets: [action(), action(), drifted] });
    await rejectsWith(run(h), "approval-unconfirmed");
  });
});

describe("runOwnerApproval: authority envelope binding", () => {
  it("binds requiredAuthority and destructive into the payload digest", () => {
    const base = canonicalPayloadDigest(expectation);
    assert.notEqual(base, canonicalPayloadDigest({ ...expectation, requiredAuthority: "T2" }));
    assert.notEqual(base, canonicalPayloadDigest({ ...expectation, destructive: true }));
  });

  it("shows the digest of the complete envelope, including authority and destructive", async () => {
    const h = harness({});
    await run(h);
    const text = h.output.join("\n");
    assert.ok(text.includes(canonicalPayloadDigest(expectation)));
    assert.match(text, /authority T1/);
    assert.match(text, /destructive: false/);
  });

  it("rejects a different authority or destructive flag before any prompt or approval", async () => {
    for (const variant of [{ requiredAuthority: "T2" as const }, { destructive: true }]) {
      const h = harness({ gets: [action(variant)] });
      await rejectsWith(run(h), "payload-mismatch");
      assert.equal(h.prompts.confirm + h.prompts.secret, 0);
      assert.equal(h.calls.approve.length, 0);
    }
  });

  it("aborts without approval when authority or destructive change after review", async () => {
    for (const variant of [{ requiredAuthority: "T3" as const }, { destructive: true }]) {
      const h = harness({ gets: [action(), action(variant)] });
      await rejectsWith(run(h), "payload-changed");
      assert.equal(h.calls.approve.length, 0);
    }
  });

  it("reports an unconfirmed outcome when authority or destructive drift in the readback", async () => {
    for (const variant of [{ requiredAuthority: "T3" as const }, { destructive: true }]) {
      const h = harness({ gets: [action(), action(), action({ state: "approved", ...variant })] });
      await rejectsWith(run(h), "approval-unconfirmed");
      assert.equal(h.calls.approve.length, 1);
    }
  });
});

describe("runOwnerApproval: supported operation", () => {
  it("refuses any expectation other than home:announce before contacting the API", async () => {
    for (const other of [
      { tool: "notes", operation: "create" },
      { tool: "home", operation: "lights" },
    ]) {
      const h = harness({});
      await rejectsWith(run(h, { ...expectation, ...other }), "unsupported-action");
      assert.equal(h.calls.get, 0);
      assert.equal(h.prompts.confirm + h.prompts.secret, 0);
      assert.equal(h.calls.approve.length, 0);
    }
  });
});

describe("createHttpOwnerApprovalTransport", () => {
  function fakeFetch(responses: Array<Response | Error>) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected extra request");
      if (next instanceof Error) throw next;
      return next;
    };
    return { fetchImpl: fetchImpl as typeof fetch, requests };
  }

  const baseUrl = new URL("http://127.0.0.1:3000/");

  it("url-encodes identifiers, uses the bearer service token and keeps the owner token in the body only", async () => {
    const { fetchImpl, requests } = fakeFetch([
      Response.json(action()),
      Response.json(action({ state: "approved" })),
    ]);
    const transport = createHttpOwnerApprovalTransport({
      baseUrl,
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });
    await transport.getAction(PROJECT, ACTION_ID);
    await transport.approve(PROJECT, ACTION_ID, { expectedRevision: 1, approvalToken: TOKEN });

    assert.equal(
      requests[0]!.url,
      `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/tool-actions/${ACTION_ID}`,
    );
    assert.equal(requests[1]!.url, `${requests[0]!.url}/approve`);
    assert.equal(requests[1]!.init.method, "POST");
    const headers = new Headers(requests[1]!.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${SERVICE_TOKEN}`);
    assert.ok(![...headers.values()].some((value) => value.includes(TOKEN)));
    assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
      expectedRevision: 1,
      approvalToken: TOKEN,
    });
    assert.ok(!requests[0]!.url.includes(TOKEN));
  });

  it("refuses non-loopback base URLs", () => {
    assert.throws(
      () =>
        createHttpOwnerApprovalTransport({
          baseUrl: new URL("https://example.com/"),
          serviceToken: SERVICE_TOKEN,
        }),
      /loopback/i,
    );
  });

  it("surfaces only status and problem type on HTTP errors and redacts echoed secrets", async () => {
    const { fetchImpl } = fakeFetch([
      Response.json(
        {
          type: "urn:jarvis:problem:not-authorized",
          title: `Rejected ${TOKEN} ${SERVICE_TOKEN}`,
          status: 403,
          detail: `token ${TOKEN}`,
        },
        { status: 403 },
      ),
    ]);
    const transport = createHttpOwnerApprovalTransport({
      baseUrl,
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });
    try {
      await transport.approve(PROJECT, ACTION_ID, { expectedRevision: 1, approvalToken: TOKEN });
      assert.fail("expected rejection");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /403/);
      assert.ok(!message.includes(TOKEN));
      assert.ok(!message.includes(SERVICE_TOKEN));
    }
  });

  it("does not resend an approval after a network error", async () => {
    const { fetchImpl, requests } = fakeFetch([new Error("socket hang up")]);
    const transport = createHttpOwnerApprovalTransport({
      baseUrl,
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });
    await assert.rejects(
      transport.approve(PROJECT, ACTION_ID, { expectedRevision: 1, approvalToken: TOKEN }),
    );
    assert.equal(requests.length, 1);
  });

  it("applies a request deadline signal", async () => {
    const { fetchImpl, requests } = fakeFetch([Response.json(action())]);
    const transport = createHttpOwnerApprovalTransport({
      baseUrl,
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
      timeoutMs: 1000,
    });
    await transport.getAction(PROJECT, ACTION_ID);
    assert.ok(requests[0]!.init.signal instanceof AbortSignal);
  });
});

describe("readHiddenLine", () => {
  function terminal(isTTY = true) {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    input.isTTY = isTTY;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode: boolean) => {
      rawModes.push(mode);
    };
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    return { input, output, rawModes, written };
  }

  it("returns the typed line without echoing it and restores the terminal mode", async () => {
    const t = terminal();
    const pending = readHiddenLine("Token: ", t.input, t.output);
    t.input.write("abc\x7fd12\r");
    assert.equal(await pending, "abd12");
    assert.deepEqual(t.rawModes, [true, false]);
    assert.ok(!t.written.join("").includes("abd12"));
    assert.ok(t.written.join("").includes("Token: "));
  });

  it("returns null on Ctrl-C and on end of input", async () => {
    const cancelled = terminal();
    const first = readHiddenLine("Token: ", cancelled.input, cancelled.output);
    cancelled.input.write("abc\x03");
    assert.equal(await first, null);
    assert.deepEqual(cancelled.rawModes, [true, false]);

    const ended = terminal();
    const second = readHiddenLine("Token: ", ended.input, ended.output);
    ended.input.end();
    assert.equal(await second, null);
  });

  it("fails closed when input is not an interactive terminal", async () => {
    const t = terminal(false);
    await assert.rejects(readHiddenLine("Token: ", t.input, t.output), /interactive/i);
  });
});

describe("parseOwnerApprovalArgs / parseOwnerApprovalExpectation", () => {
  it("requires project, action and expectation file", () => {
    assert.deepEqual(
      parseOwnerApprovalArgs([
        "--project",
        PROJECT,
        "--action",
        ACTION_ID,
        "--expect-file",
        "e.json",
      ]),
      { projectId: PROJECT, actionId: ACTION_ID, expectFile: "e.json" },
    );
    assert.deepEqual(
      parseOwnerApprovalArgs([
        `--project=${PROJECT}`,
        `--action=${ACTION_ID}`,
        "--expect-file=e.json",
      ]),
      { projectId: PROJECT, actionId: ACTION_ID, expectFile: "e.json" },
    );
    assert.throws(() => parseOwnerApprovalArgs(["--project", PROJECT]), /--action/);
    assert.throws(
      () => parseOwnerApprovalArgs(["--project", PROJECT, "--action", ACTION_ID]),
      /--expect-file/,
    );
  });

  it("rejects credential-bearing and unknown options", () => {
    for (const flag of [
      "--token",
      "--approval-token",
      "--approvalToken=abc",
      "--service-token",
      "--bogus",
    ]) {
      assert.throws(
        () =>
          parseOwnerApprovalArgs([
            "--project",
            PROJECT,
            "--action",
            ACTION_ID,
            "--expect-file",
            "e.json",
            flag,
            "x",
          ]),
        /not accepted|unknown/i,
      );
    }
  });

  it("validates the expectation file shape", () => {
    assert.deepEqual(parseOwnerApprovalExpectation(JSON.stringify(expectation)), expectation);
    assert.throws(() => parseOwnerApprovalExpectation("not json"), /JSON/);
    assert.throws(
      () => parseOwnerApprovalExpectation(JSON.stringify({ tool: "home" })),
      /operation|arguments/,
    );
    assert.throws(
      () =>
        parseOwnerApprovalExpectation(
          JSON.stringify({ tool: "home", operation: "announce", arguments: [] }),
        ),
      /arguments/,
    );
  });

  it("requires requiredAuthority and destructive", () => {
    const { requiredAuthority: _authority, ...withoutAuthority } = expectation;
    const { destructive: _destructive, ...withoutDestructive } = expectation;
    assert.throws(
      () => parseOwnerApprovalExpectation(JSON.stringify(withoutAuthority)),
      /requiredAuthority/,
    );
    assert.throws(
      () => parseOwnerApprovalExpectation(JSON.stringify(withoutDestructive)),
      /destructive/,
    );
    assert.throws(
      () => parseOwnerApprovalExpectation(JSON.stringify({ ...expectation, destructive: "no" })),
      /destructive/,
    );
  });

  it("accepts only the home:announce operation", () => {
    assert.throws(
      () =>
        parseOwnerApprovalExpectation(
          JSON.stringify({ ...expectation, tool: "notes", operation: "create" }),
        ),
      /home:announce/,
    );
  });
});
