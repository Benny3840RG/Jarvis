import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Errand } from "../src/errands/errand.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import {
  AuthoritativeVoiceCompletionResolver,
  completionMatchRank,
  VOICE_COMPLETION_UNAVAILABLE_REASON,
  VOICE_REMINDER_CANCEL_UNAVAILABLE_REASON,
  VOICE_RESCHEDULE_DISABLED_REASON,
  type VoiceCompletionResolver,
} from "../src/voice/voiceCompletion.js";
import { VOICE_COMMANDS } from "../src/voice/voiceCommands.js";
import { describeVoiceDictation, parseVoiceDictation } from "../src/voice/voiceDictation.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return { id, title, completed: false, category: "personal", createdAt: 1, ...extra };
}

function errand(id: string, title: string, extra: Partial<Errand> = {}): Errand {
  return { id, title, status: "open", createdAt: 1, updatedAt: 1, ...extra };
}

const VOICE_PROJECT = { resolve: async () => ({ projectId: "voice-1", expectedRevision: 1 }) };

function resolver(tasks: Task[], errands: Errand[] = []) {
  return new AuthoritativeVoiceCompletionResolver({
    tasks: { listTasks: async () => tasks },
    errands: { list: async () => errands },
    voiceProject: VOICE_PROJECT,
  });
}

describe("voice completion grammar", () => {
  it("captures the spoken reference and the spoken kind", () => {
    const cases: Array<[string, string, string]> = [
      ["tick off bar oil", "client.complete-item", "Bar oil"],
      ["cross off the milk", "client.complete-item", "Milk"],
      ["check off my errand milk", "client.complete-errand", "Milk"],
      ["mark bar oil as done", "client.complete-item", "Bar oil"],
      ["mark the task order bar oil complete", "client.complete-task", "Order bar oil"],
      ["set the errand silicone as finished", "client.complete-errand", "Silicone"],
      ["complete the task quote the Smith fence", "client.complete-task", "Quote the Smith fence"],
      ["finish errand: pick up the trailer", "client.complete-errand", "Pick up the trailer"],
    ];
    for (const [utterance, id, title] of cases) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.equal(dictation?.command.id, id, utterance);
      assert.deepEqual(dictation?.capture, { title }, utterance);
    }
  });

  it("fails closed on vague or unsafe completions", () => {
    for (const utterance of [
      "tick off",
      "tick off it",
      "mark it done",
      "mark that as done",
      "mark the task done",
      "tick off everything",
      "tick off all of them",
      "tick off the",
      "mark my done",
      "tick off nolan",
      "tick off confirm",
      "tick off milk and send the quote",
      "mark don't order oil done",
      "complete the quote", // a kind word is required after complete/finish
      "finish the deck",
      "mark the quote sent", // not a completion word
    ]) {
      assert.equal(parseVoiceDictation(utterance, "client"), undefined, utterance);
    }
  });

  it("leaves creation dictations alone", () => {
    assert.equal(
      parseVoiceDictation("add a task: mark the gate done", "client")?.command.id,
      "client.capture-task",
    );
    assert.equal(
      parseVoiceDictation("remind me to tick off the rego", "client")?.command.id,
      "client.follow-up-reminder",
    );
  });

  it("is not a catalog command and has no governed operation until resolved", () => {
    const item = parseVoiceDictation("tick off bar oil", "client");
    assert.ok(item);
    assert.equal(item.command.proposes, undefined);
    for (const id of ["client.complete-item", "client.complete-task", "client.complete-errand"]) {
      assert.equal(
        VOICE_COMMANDS.find((entry) => entry.id === id),
        undefined,
        id,
      );
    }
    assert.equal(describeVoiceDictation(item), "Mark “Bar oil” done");
  });
});

describe("voice completion matching", () => {
  it("ranks exact titles above whole-word fragments and ignores partial words", () => {
    assert.equal(completionMatchRank("order bar oil", "Order bar oil"), 2);
    assert.equal(completionMatchRank("Bar-oil", "bar oil"), 2);
    assert.equal(completionMatchRank("bar oil", "Order bar oil"), 1);
    assert.equal(completionMatchRank("oil", "Order bar oil"), 1);
    assert.equal(completionMatchRank("oi", "Order bar oil"), 0);
    assert.equal(completionMatchRank("oil bar", "Order bar oil"), 0);
    assert.equal(completionMatchRank("", "Order bar oil"), 0);
  });

  it("resolves exactly one open item, preferring an exact title", async () => {
    const found = await resolver([
      task("t1", "Oil", { projectId: "voice-1" }),
      task("t2", "Order bar oil", { projectId: "voice-1" }),
    ]).resolve({ kind: "any", reference: "oil" });
    assert.deepEqual(found, { status: "found", target: { kind: "task", id: "t1", title: "Oil" } });
  });

  it("refuses ties, done items and tasks outside the voice project", async () => {
    const tasks = [
      task("t1", "Order bar oil", { projectId: "voice-1" }),
      task("t2", "Change the oil filter", { projectId: "voice-1" }),
      task("t3", "Order chain"),
      task("t4", "Sharpen chains", { projectId: "voice-1", completed: true }),
    ];
    const errands = [errand("e1", "Milk", { status: "done" }), errand("e2", "Bar oil")];
    const r = resolver(tasks, errands);
    assert.match(
      JSON.stringify(await r.resolve({ kind: "any", reference: "oil" })),
      /3 open items match/,
    );
    assert.match(
      JSON.stringify(await r.resolve({ kind: "task", reference: "order chain" })),
      /was not captured by voice/,
    );
    assert.match(
      JSON.stringify(await r.resolve({ kind: "task", reference: "sharpen chains" })),
      /No open task matches/,
    );
    assert.match(
      JSON.stringify(await r.resolve({ kind: "errand", reference: "milk" })),
      /No open errand matches/,
    );
    assert.deepEqual(await r.resolve({ kind: "errand", reference: "bar oil" }), {
      status: "found",
      target: { kind: "errand", id: "e2", title: "Bar oil" },
    });
    // The exact errand title outranks the task that only contains the words.
    assert.deepEqual(await r.resolve({ kind: "any", reference: "bar oil" }), {
      status: "found",
      target: { kind: "errand", id: "e2", title: "Bar oil" },
    });
  });

  it("explains an uncommissioned voice project and fails closed on source errors", async () => {
    const uncommissioned = new AuthoritativeVoiceCompletionResolver({
      tasks: { listTasks: async () => [task("t1", "Order bar oil", { projectId: "voice-1" })] },
      errands: { list: async () => [] },
      voiceProject: { resolve: async () => ({ reason: "Run npm run commission:voice-project." }) },
    });
    assert.match(
      JSON.stringify(await uncommissioned.resolve({ kind: "task", reference: "bar oil" })),
      /cannot be completed by voice: Run npm run commission:voice-project\./,
    );
    const broken = new AuthoritativeVoiceCompletionResolver({
      tasks: {
        listTasks: async () => {
          throw new Error("convex down");
        },
      },
      errands: {
        list: async () => {
          throw new Error("disk");
        },
      },
      voiceProject: VOICE_PROJECT,
    });
    assert.deepEqual(await broken.resolve({ kind: "task", reference: "x" }), {
      status: "unresolved",
      reason: "Task records are unavailable.",
    });
    assert.deepEqual(await broken.resolve({ kind: "errand", reference: "x" }), {
      status: "unresolved",
      reason: "Errand records are unavailable.",
    });
    const missing = new AuthoritativeVoiceCompletionResolver({});
    assert.deepEqual(await missing.resolve({ kind: "any", reference: "x" }), {
      status: "unresolved",
      reason: VOICE_COMPLETION_UNAVAILABLE_REASON,
    });
  });
});

describe("voice completion in the session", () => {
  function session(completions?: VoiceCompletionResolver) {
    return new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      ...(completions ? { completions } : {}),
    });
  }

  it("arms the resolved item, and the confirm carries exactly that item", async () => {
    const s = session(resolver([task("t1", "Order bar oil", { projectId: "voice-1" })]));
    const out = await s.handle({
      transcript: "tick off bar oil",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "awaiting-confirmation");
    assert.deepEqual(s.pending()?.capture, { title: "Order bar oil", targetId: "t1" });
    assert.equal(s.pending()?.command.id, "client.complete-task");
    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_000,
    });
    assert.equal(confirmed.decision, "proposed");
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.capture, { title: "Order bar oil", targetId: "t1" });
    assert.deepEqual(confirmed.command.proposes, { tool: "tasks", operation: "complete" });
  });

  it("never resolves unwoken speech", async () => {
    let reads = 0;
    const s = session({
      resolve: async () => {
        reads += 1;
        return { status: "unresolved", reason: "x" };
      },
    });
    const out = await s.handle({ transcript: "tick off bar oil", isFinal: true, now: 1_000 });
    assert.notEqual(out.decision, "awaiting-confirmation");
    assert.equal(reads, 0);
  });

  it("is unavailable without a resolver, or when the resolver throws", async () => {
    for (const completions of [
      undefined,
      {
        resolve: async (): Promise<never> => {
          throw new Error("boom");
        },
      },
    ]) {
      const s = session(completions);
      const out = await s.handle({
        transcript: "tick off bar oil",
        isFinal: true,
        wakeAuthorized: true,
        now: 1_000,
      });
      assert.equal(out.decision, "completion-unresolved");
      assert.ok(out.decision === "completion-unresolved");
      assert.equal(out.reason, VOICE_COMPLETION_UNAVAILABLE_REASON);
      assert.equal(s.pending(), undefined);
    }
  });

  it("a fresh unresolved completion voids an earlier pending capture", async () => {
    const s = session(resolver([]));
    await s.handle({
      transcript: "add a task: order bar oil",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.ok(s.pending());
    const out = await s.handle({
      transcript: "tick off the sprocket",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_000,
    });
    assert.equal(out.decision, "completion-unresolved");
    assert.equal(s.pending(), undefined);
  });

  it("is ambiguous when an alternative dictates something else", async () => {
    let reads = 0;
    const s = session({
      resolve: async () => {
        reads += 1;
        return { status: "unresolved", reason: "x" };
      },
    });
    const out = await s.handle({
      transcript: "tick off bar oil",
      alternatives: ["add a task: bar oil"],
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "ambiguous");
    assert.equal(reads, 0);
    assert.equal(s.pending(), undefined);
  });
});

function reminder(id: string, title: string, projectId?: string): Reminder {
  return { id, title, createdAt: 1, ...(projectId ? { projectId } : {}) };
}

describe("voice reminder cancellation", () => {
  it("captures the spoken reminder reference in every form", () => {
    const cases: Array<[string, string]> = [
      ["cancel the bar oil reminder", "Bar oil"],
      ["cancel my reminder to order bar oil", "Order bar oil"],
      ["delete the reminder: call Dave", "Call Dave"],
      ["remove reminder about the rego", "Rego"],
      ["scrap the reminder for the Smith quote", "Smith quote"],
      ["drop my call Dave reminder", "Call Dave"],
      ["clear the reminder called renew the rego", "Renew the rego"],
    ];
    for (const [utterance, title] of cases) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.equal(dictation?.command.id, "client.cancel-reminder", utterance);
      assert.deepEqual(dictation?.command.proposes, { tool: "reminders", operation: "cancel" });
      assert.deepEqual(dictation?.capture, { title }, utterance);
    }
    assert.equal(
      describeVoiceDictation({
        command: parseVoiceDictation("cancel the bar oil reminder", "client")!.command,
        capture: { title: "Order bar oil" },
      }),
      "Cancel reminder “Order bar oil”",
    );
  });

  it("fails closed on vague, chained or unsafe cancellations", () => {
    for (const utterance of [
      "cancel the reminder",
      "cancel that reminder",
      "cancel it reminder",
      "delete my reminder",
      "cancel the reminder to it",
      "cancel the reminder reminder",
      "cancel all reminders",
      "cancel everything reminder",
      "cancel the reminder to order oil and send the quote",
      "cancel the reminder to nolan",
      "cancel the reminder to confirm",
      "cancel the reminder to not call Dave",
    ]) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.notEqual(dictation?.command.id, "client.cancel-reminder", utterance);
    }
    // Bare control words are not dictations at all.
    assert.equal(parseVoiceDictation("cancel", "client"), undefined);
    assert.equal(parseVoiceDictation("cancel command", "client"), undefined);
    // Creating a reminder is unaffected.
    assert.equal(
      parseVoiceDictation("remind me to renew the rego", "client")?.command.id,
      "client.follow-up-reminder",
    );
    assert.equal(
      VOICE_COMMANDS.find((entry) => entry.id === "client.cancel-reminder"),
      undefined,
    );
  });

  function reminderResolver(reminders: Reminder[], voiceProject: unknown = VOICE_PROJECT) {
    return new AuthoritativeVoiceCompletionResolver({
      tasks: { listTasks: async () => [task("t1", "Order bar oil", { projectId: "voice-1" })] },
      errands: { list: async () => [errand("e1", "Bar oil")] },
      reminders: { listReminders: async () => reminders },
      voiceProject: voiceProject as typeof VOICE_PROJECT,
    });
  }

  it("resolves only reminders, and only inside the voice project", async () => {
    const r = reminderResolver([
      reminder("r1", "Order bar oil", "voice-1"),
      reminder("r2", "Change the oil filter", "voice-1"),
      reminder("r3", "Renew the rego"),
    ]);
    // Tasks and errands with the same words are never cancellation targets.
    assert.deepEqual(await r.resolve({ kind: "reminder", reference: "bar oil" }), {
      status: "found",
      target: { kind: "reminder", id: "r1", title: "Order bar oil" },
    });
    assert.deepEqual(await r.resolve({ kind: "reminder", reference: "oil" }), {
      status: "unresolved",
      reason: "2 reminders match “oil”. Say more of the title.",
    });
    assert.deepEqual(await r.resolve({ kind: "reminder", reference: "sprocket" }), {
      status: "unresolved",
      reason: "No reminder matches “sprocket”.",
    });
    assert.deepEqual(await r.resolve({ kind: "reminder", reference: "rego" }), {
      status: "unresolved",
      reason:
        "Reminder “Renew the rego” was not captured by voice, so voice cannot cancel it. Cancel it on the HUD.",
    });
    // Completion lookups never see reminders.
    assert.match(
      JSON.stringify(await r.resolve({ kind: "any", reference: "rego" })),
      /No open task or errand matches/,
    );
  });

  it("fails closed when reminders or the voice project cannot be read", async () => {
    assert.match(
      JSON.stringify(
        await reminderResolver([reminder("r1", "Order bar oil", "voice-1")], {
          resolve: async () => ({ reason: "Run npm run commission:voice-project." }),
        }).resolve({ kind: "reminder", reference: "bar oil" }),
      ),
      /cannot be cancelled by voice: Run npm run commission:voice-project\./,
    );
    const broken = new AuthoritativeVoiceCompletionResolver({
      reminders: {
        listReminders: async () => {
          throw new Error("convex down");
        },
      },
      voiceProject: VOICE_PROJECT,
    });
    assert.deepEqual(await broken.resolve({ kind: "reminder", reference: "x" }), {
      status: "unresolved",
      reason: "Reminder records are unavailable.",
    });
    const missing = new AuthoritativeVoiceCompletionResolver({
      tasks: { listTasks: async () => [] },
      errands: { list: async () => [] },
    });
    assert.deepEqual(await missing.resolve({ kind: "reminder", reference: "x" }), {
      status: "unresolved",
      reason: VOICE_REMINDER_CANCEL_UNAVAILABLE_REASON,
    });
  });

  it("arms the resolved reminder in the session, and is unavailable without a resolver", async () => {
    const s = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      completions: reminderResolver([reminder("r1", "Order bar oil", "voice-1")]),
    });
    const out = await s.handle({
      transcript: "cancel the bar oil reminder",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "awaiting-confirmation");
    assert.equal(s.pending()?.command.id, "client.cancel-reminder");
    assert.deepEqual(s.pending()?.capture, { title: "Order bar oil", targetId: "r1" });
    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_000,
    });
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.command.proposes, { tool: "reminders", operation: "cancel" });

    const bare = new VoiceSession({ profile: "client", provider: new AbsentHardwareProvider() });
    const refused = await bare.handle({
      transcript: "cancel the bar oil reminder",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.ok(refused.decision === "completion-unresolved");
    assert.equal(refused.reason, VOICE_REMINDER_CANCEL_UNAVAILABLE_REASON);
  });
});

describe("voice errand removal", () => {
  it("captures the spoken errand reference in every form", () => {
    const cases: Array<[string, string]> = [
      ["remove milk from the errands", "Milk"],
      ["take the milk off my shopping list", "Milk"],
      ["delete the screws from the errand list", "Screws"],
      ["scrap bar oil off the errands list", "Bar oil"],
      ["strike silicone off the errands", "Silicone"],
      ["remove the errand: pick up the trailer", "Pick up the trailer"],
      ["delete errand milk", "Milk"],
    ];
    for (const [utterance, title] of cases) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.equal(dictation?.command.id, "client.remove-errand", utterance);
      assert.deepEqual(dictation?.command.proposes, { tool: "errands", operation: "remove" });
      assert.deepEqual(dictation?.capture, { title }, utterance);
    }
    assert.equal(
      describeVoiceDictation({
        command: parseVoiceDictation("remove milk from the errands", "client")!.command,
        capture: { title: "Milk" },
      }),
      "Remove errand “Milk” from the list",
    );
  });

  it("fails closed on vague, chained or unsafe removals and leaves other commands alone", () => {
    for (const utterance of [
      "remove it from the errands",
      "take everything off the shopping list",
      "remove all of them from my errands",
      "delete the errand",
      "remove the errand: it",
      "take milk and send the quote off the errands",
      "remove nolan from the errands",
      "remove confirm from the errands",
    ]) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.notEqual(dictation?.command.id, "client.remove-errand", utterance);
    }
    assert.equal(
      parseVoiceDictation("add milk to the errands", "client")?.command.id,
      "client.capture-errand",
    );
    assert.equal(
      parseVoiceDictation("cancel the bar oil reminder", "client")?.command.id,
      "client.cancel-reminder",
    );
    assert.equal(
      parseVoiceDictation("cross off the milk", "client")?.command.id,
      "client.complete-item",
    );
    assert.equal(parseVoiceDictation("remove milk", "client"), undefined);
    assert.equal(
      VOICE_COMMANDS.find((entry) => entry.id === "client.remove-errand"),
      undefined,
    );
  });

  it("arms the resolved open errand for removal, never a task or a done errand", async () => {
    const s = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      completions: resolver(
        [task("t1", "Milk run", { projectId: "voice-1" })],
        [errand("e1", "Milk"), errand("e2", "Screws", { status: "done" })],
      ),
    });
    const out = await s.handle({
      transcript: "take milk off the errands",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "awaiting-confirmation");
    assert.equal(s.pending()?.command.id, "client.remove-errand");
    assert.deepEqual(s.pending()?.capture, { title: "Milk", targetId: "e1" });
    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_000,
    });
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.command.proposes, { tool: "errands", operation: "remove" });

    const done = await s.handle({
      transcript: "remove screws from the errands",
      isFinal: true,
      wakeAuthorized: true,
      now: 3_000,
    });
    assert.ok(done.decision === "completion-unresolved");
    assert.equal(done.command.id, "client.remove-errand");
    assert.equal(done.reason, "No open errand matches “Screws”.");
  });
});

describe("voice reminder reschedule (AM-017, planned)", () => {
  // Monday 16 November 2026, 10:00 in Sydney (AEDT, UTC+11).
  const DUE = { now: Date.UTC(2026, 10, 15, 23, 0), timezone: "Australia/Sydney" };
  const FRIDAY_9AM = Date.UTC(2026, 10, 19, 22, 0);

  it("captures the reference and the new due value in every form", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        "move the bar oil reminder to friday at 9 am",
        "Bar oil",
        { dueRaw: "friday at 9 am", dueAt: FRIDAY_9AM, dueTimezone: "Australia/Sydney" },
      ],
      [
        "push my reminder to call Dave to friday at 9 am",
        "Call Dave",
        { dueRaw: "friday at 9 am", dueAt: FRIDAY_9AM, dueTimezone: "Australia/Sydney" },
      ],
      [
        "reschedule the reminder about the trip to Sydney until friday at 9 am",
        "Trip to Sydney",
        { dueRaw: "friday at 9 am", dueAt: FRIDAY_9AM, dueTimezone: "Australia/Sydney" },
      ],
      ["move the rego reminder to tomorrow", "Rego", { dueRaw: "tomorrow" }],
      [
        "bump the rego reminder to 3 pm",
        "Rego",
        {
          dueRaw: "at 3 pm",
          dueAt: Date.UTC(2026, 10, 16, 4, 0),
          dueTimezone: "Australia/Sydney",
        },
      ],
      ["shift the rego reminder to friday at 7", "Rego", { dueRaw: "friday at 7" }],
    ];
    for (const [utterance, title, due] of cases) {
      const dictation = parseVoiceDictation(utterance, "client", DUE);
      assert.equal(dictation?.command.id, "client.reschedule-reminder", utterance);
      assert.deepEqual(dictation?.command.proposes, { tool: "reminders", operation: "reschedule" });
      assert.deepEqual(dictation?.capture, { title, ...due }, utterance);
    }
    const readBack = describeVoiceDictation(
      parseVoiceDictation("move the bar oil reminder to friday at 9 am", "client", DUE)!,
    );
    assert.equal(readBack, "Reschedule reminder “Bar oil” due Fri, 20 Nov, 9:00 am");
  });

  it("fails closed when the new time is missing, vague, past or unparseable", () => {
    for (const utterance of [
      "move the bar oil reminder to next friday", // never resolved
      "move the bar oil reminder to today at 9 am", // already passed
      "move the bar oil reminder to tonight at 8 am", // contradiction
      "move the bar oil reminder to later",
      "move the bar oil reminder to friday week",
      "move the reminder to friday",
      "move that reminder to friday",
      "move my reminder to it to friday",
      "move the bar oil reminder to friday and send the quote",
    ]) {
      const dictation = parseVoiceDictation(utterance, "client", DUE);
      assert.notEqual(dictation?.command.id, "client.reschedule-reminder", utterance);
    }
    // Without the owner clock and timezone no new time can be resolved.
    assert.equal(
      parseVoiceDictation("move the bar oil reminder to friday at 9 am", "client"),
      undefined,
    );
    assert.equal(
      VOICE_COMMANDS.find((entry) => entry.id === "client.reschedule-reminder"),
      undefined,
    );
  });

  function rescheduleSession(rescheduleReminders: boolean, reads: { count: number }) {
    return new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      timezone: "Australia/Sydney",
      rescheduleReminders,
      completions: {
        resolve: async (input) => {
          reads.count += 1;
          return new AuthoritativeVoiceCompletionResolver({
            reminders: { listReminders: async () => [reminder("r1", "Order bar oil", "voice-1")] },
            voiceProject: VOICE_PROJECT,
          }).resolve(input);
        },
      },
    });
  }

  it("is refused before any records are read while AM-017 is not enabled", async () => {
    const reads = { count: 0 };
    const s = rescheduleSession(false, reads);
    const out = await s.handle({
      transcript: "move the bar oil reminder to friday at 9 am",
      isFinal: true,
      wakeAuthorized: true,
      now: DUE.now,
    });
    assert.ok(out.decision === "completion-unresolved");
    assert.equal(out.reason, VOICE_RESCHEDULE_DISABLED_REASON);
    assert.equal(reads.count, 0);
    assert.equal(s.pending(), undefined);
  });

  it("when enabled, arms the resolved reminder with exactly the heard due value", async () => {
    const reads = { count: 0 };
    const s = rescheduleSession(true, reads);
    const out = await s.handle({
      transcript: "move the bar oil reminder to friday at 9 am",
      isFinal: true,
      wakeAuthorized: true,
      now: DUE.now,
    });
    assert.equal(out.decision, "awaiting-confirmation");
    assert.equal(s.pending()?.command.id, "client.reschedule-reminder");
    assert.deepEqual(s.pending()?.capture, {
      title: "Order bar oil",
      targetId: "r1",
      dueRaw: "friday at 9 am",
      dueAt: FRIDAY_9AM,
      dueTimezone: "Australia/Sydney",
    });
    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: DUE.now + 1_000,
    });
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.command.proposes, { tool: "reminders", operation: "reschedule" });
  });
});
