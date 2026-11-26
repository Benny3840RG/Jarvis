import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";
import {
  VoiceConversationService,
  type ReasonerResult,
  type VoiceConversationReasoner,
} from "../src/voice/voiceConversation.js";
import { parseVoiceDictation } from "../src/voice/voiceDictation.js";
import { proposalUtterance, type VoiceProposal } from "../src/voice/voiceProposal.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { VoiceSession } from "../src/voice/voiceSession.js";
import { VoiceWriteTarget } from "../src/voice/voiceWriteTarget.js";

// Monday 16 November 2026, 10:00 in Melbourne.
const DUE = { now: Date.UTC(2026, 10, 15, 23, 0), timezone: "Australia/Melbourne" };

describe("proposal sentences", () => {
  it("builds the canonical dictation sentence the grammar reads back", () => {
    const cases: Array<[VoiceProposal, string, string, Record<string, unknown>]> = [
      [
        { action: "add_task", title: "Quote the Smith fence", category: "work" },
        "add a work task: Quote the Smith fence",
        "client.capture-task",
        { title: "Quote the Smith fence", category: "work" },
      ],
      [
        { action: "add_errand", title: "Bar oil" },
        "add an errand: Bar oil",
        "client.capture-errand",
        { title: "Bar oil" },
      ],
      [
        { action: "add_reminder", title: "call Dave", due: "Tomorrow at 7 am" },
        "remind me to call Dave tomorrow at 7 am",
        "client.follow-up-reminder",
        { title: "Call Dave", dueRaw: "tomorrow at 7 am" },
      ],
      [
        { action: "complete", reference: "bar oil", kind: "errand" },
        "tick off the errand bar oil",
        "client.complete-errand",
        { title: "Bar oil" },
      ],
      [
        { action: "complete", reference: "milk" },
        "tick off milk",
        "client.complete-item",
        { title: "Milk" },
      ],
      [
        { action: "cancel_reminder", reference: "the rego" },
        "cancel the reminder: the rego",
        "client.cancel-reminder",
        { title: "Rego" },
      ],
      [
        { action: "remove_errand", reference: "screws" },
        "remove the errand: screws",
        "client.remove-errand",
        { title: "Screws" },
      ],
      [
        {
          action: "reschedule_reminder",
          reference: "call Dave to book the trailer",
          due: "friday at 9 am",
        },
        "move the reminder called call Dave to book the trailer to friday at 9 am",
        "client.reschedule-reminder",
        { title: "Call Dave to book the trailer", dueRaw: "friday at 9 am" },
      ],
    ];
    for (const [proposal, sentence, commandId, capture] of cases) {
      assert.equal(proposalUtterance(proposal, DUE), sentence, proposal.action);
      const dictation = parseVoiceDictation(sentence, "client", DUE);
      assert.equal(dictation?.command.id, commandId, sentence);
      for (const [key, value] of Object.entries(capture)) {
        assert.equal(
          (dictation?.capture as Record<string, unknown>)[key],
          value,
          `${sentence} ${key}`,
        );
      }
    }
  });

  it("refuses a due phrase outside the bounded grammar instead of hiding it in the title", () => {
    for (const due of ["next friday", "in a fortnight", "the 21st", "later"]) {
      assert.equal(
        proposalUtterance({ action: "add_reminder", title: "Call Dave", due }, DUE),
        undefined,
        due,
      );
    }
  });

  it("accepts a relative due phrase the grammar now counts from now", () => {
    assert.equal(
      proposalUtterance({ action: "add_reminder", title: "Call Dave", due: "in two hours" }, DUE),
      "remind me to Call Dave in two hours",
    );
  });

  it("leaves the grammar's guards in charge of the model's text", () => {
    // A chained action in a title, or a wake word, is refused by the grammar itself.
    for (const proposal of [
      { action: "add_errand", title: "Milk and send the quote" },
      { action: "add_task", title: "Nolan confirm" },
      { action: "complete", reference: "everything" },
    ] as VoiceProposal[]) {
      const sentence = proposalUtterance(proposal, DUE);
      assert.ok(sentence);
      assert.equal(parseVoiceDictation(sentence, "client", DUE), undefined, sentence);
    }
  });
});

function scripted(result: ReasonerResult, queryFirst = false): VoiceConversationReasoner {
  return {
    async reply(input) {
      if (queryFirst) await input.query("client.open-errands");
      return result;
    },
  };
}

function session() {
  return new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    timezone: "Australia/Melbourne",
  });
}

describe("proposal in the conversation service", () => {
  it("turns a proposal into its sentence and remembers it", async () => {
    const service = new VoiceConversationService({
      reasoner: scripted({
        status: "proposed",
        proposal: { action: "add_errand", title: "Bar oil" },
      }),
    });
    const s = session();
    assert.deepEqual(
      await service.respond({ session: s, transcript: "chuck bar oil on the list" }),
      {
        status: "proposed",
        utterance: "add an errand: Bar oil",
      },
    );
    assert.match(service.history(s).at(-1)?.content ?? "", /Proposed for confirmation/);
  });

  it("refuses a proposal that rode along with a query, or cannot be expressed", async () => {
    const withQuery = new VoiceConversationService({
      reasoner: scripted(
        { status: "proposed", proposal: { action: "add_errand", title: "Bar oil" } },
        true,
      ),
    });
    assert.deepEqual(await withQuery.respond({ session: session(), transcript: "x" }), {
      status: "unavailable",
      reason: "tool-limit",
    });
    const badDue = new VoiceConversationService({
      reasoner: scripted({
        status: "proposed",
        proposal: { action: "add_reminder", title: "Call Dave", due: "next friday" },
      }),
    });
    assert.deepEqual(await badDue.respond({ session: session(), transcript: "x" }), {
      status: "unavailable",
      reason: "ungrounded",
    });
  });
});

// ---- over HTTP: free speech -> read-back -> confirm -> staged, never executed ----

const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

class Actions implements ToolActionService {
  readonly rows = new Map<string, ToolAction>();
  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const row: ToolAction = {
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      baseRevision: input.expectedRevision,
      state: "proposed",
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    this.rows.set(row.actionId, row);
    return row;
  }
  async get(): Promise<ToolAction | null> {
    return null;
  }
  async list(): Promise<ToolAction[]> {
    return [...this.rows.values()];
  }
  async approve(): Promise<ToolAction> {
    throw new Error("voice never approves");
  }
  async reject(): Promise<ToolAction> {
    throw new Error("voice never rejects");
  }
}

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("not used");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

async function open(reasoner: VoiceConversationReasoner) {
  const config: HttpAppConfig = {
    version: "0.1.0",
    sourceVersion: "voice-proposal-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: "secret",
    previousToken: undefined,
  };
  const actions = new Actions();
  const errands = new InMemoryErrandStore();
  const app = await createJarvisHttpApp({
    config,
    credentialsRuntime: captureCredentials({
      serviceToken: "secret",
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    persistence: persistence(),
    providerName: "json",
    logger: false,
    toolActionService: actions,
    errandStore: errands,
    voiceWriteTarget: new VoiceWriteTarget("nolan-voice", { revision: async () => 2 }),
    voiceConversation: new VoiceConversationService({ reasoner }),
  });
  openApps.push(app);
  const headers = { authorization: "Bearer secret" };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/voice/sessions",
    headers,
    payload: { profile: "client" },
  });
  const sessionId = created.json().sessionId as string;
  const say = async (transcript: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/voice/sessions/${sessionId}/utterances`,
        headers,
        payload: { transcript, isFinal: true },
      })
    ).json();
  return { actions, errands, say };
}

describe("free speech over HTTP", () => {
  it("reads a proposal back, stages it only on confirm, and never executes it", async () => {
    let seen = "";
    const { actions, errands, say } = await open({
      async reply(input) {
        seen = input.transcript;
        return { status: "proposed", proposal: { action: "add_errand", title: "Bar oil" } };
      },
    });
    const heard = await say("Nolan, chuck some bar oil on the shopping list would ya");
    assert.equal(seen, "chuck some bar oil on the shopping list would ya");
    assert.equal(heard.dispatch.decision, "awaiting-confirmation");
    assert.equal(heard.dispatch.command.id, "client.capture-errand");
    assert.deepEqual(heard.dispatch.capture, { title: "Bar oil" });
    assert.equal(actions.rows.size, 0, "nothing is staged before confirm");

    const confirmed = await say("Nolan confirm");
    assert.equal(confirmed.dispatch.decision, "proposed");
    const [staged] = [...actions.rows.values()];
    assert.equal(`${staged?.tool}:${staged?.operation}`, "errands:create");
    assert.deepEqual(staged?.arguments, { title: "Bar oil" });
    assert.equal(staged?.state, "proposed", "staged for approval, not approved");
    assert.equal((await errands.list()).length, 0, "nothing is written");
  });

  it("reports an unusable proposal as not understood and arms nothing", async () => {
    const { actions, say } = await open({
      async reply() {
        return {
          status: "proposed",
          proposal: { action: "add_errand", title: "Milk and send the quote" },
        };
      },
    });
    const heard = await say("Nolan, sort the milk out for me mate");
    assert.equal(heard.dispatch.decision, "conversation-unavailable");
    assert.equal(heard.dispatch.conversationReason, "ungrounded");
    assert.equal(heard.pending, null);
    assert.equal((await say("Nolan confirm")).dispatch.decision, "confirmation-not-pending");
    assert.equal(actions.rows.size, 0);
  });

  it("never reaches the model for speech the grammar already understands", async () => {
    let calls = 0;
    const { say } = await open({
      async reply() {
        calls += 1;
        return { status: "answered", reply: "x" };
      },
    });
    const heard = await say("Nolan, add an errand: milk");
    assert.equal(heard.dispatch.decision, "awaiting-confirmation");
    assert.equal(calls, 0);
  });
});
