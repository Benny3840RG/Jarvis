import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Errand } from "../src/errands/errand.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import type { Project } from "../src/projects/project.js";
import {
  createAuthoritativeVoiceQueries,
  type AuthoritativeVoiceQuerySources,
} from "../src/voice/authoritativeVoiceQuery.js";
import { VOICE_COMMANDS } from "../src/voice/voiceCommands.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { parseVoiceDictation } from "../src/voice/voiceDictation.js";
import { DAILY_RUNDOWN_COMMAND_ID, matchVoiceRundown } from "../src/voice/voiceRundown.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

// 11:30 am Wednesday 7 October 2026 in Melbourne.
const NOW = Date.parse("2026-10-07T00:30:00.000Z");
const HOUR = 3_600_000;

function boom(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`unexpected ${name}`));
}

function sources(
  overrides: Partial<AuthoritativeVoiceQuerySources> = {},
): AuthoritativeVoiceQuerySources {
  return {
    timezone: "Australia/Melbourne",
    tasks: { listTasks: boom("tasks") },
    reminders: { listReminders: boom("reminders") },
    projects: { list: boom("projects") },
    quotes: { list: boom("quotes") },
    assets: { list: boom("assets") },
    enquiries: { list: boom("enquiries") },
    invoices: { list: boom("invoices") },
    errands: { list: boom("errands") },
    builds: { list: boom("builds") },
    ...overrides,
  };
}

function project(
  title: string,
  scheduledFor: string,
  status: Project["status"] = "active",
): Project {
  return { id: title, clientId: "c1", title, status, scheduledFor, createdAt: 1, updatedAt: 1 };
}

function task(title: string, completed = false): Task {
  return { id: title, title, completed, category: "home", createdAt: 1 };
}

function reminder(title: string, dueAt?: number): Reminder {
  return { id: title, title, ...(dueAt === undefined ? {} : { dueAt }), createdAt: 1 };
}

function errand(title: string, status: Errand["status"] = "open"): Errand {
  return { id: title, title, status, createdAt: 1, updatedAt: 1 };
}

const FULL_DAY = {
  projects: {
    list: async () => [
      project("Smith fence", "2026-10-07"),
      project("Done hedge", "2026-10-07", "done"),
      project("Next week", "2026-10-14"),
    ],
  },
  reminders: {
    listReminders: async () => [
      reminder("Call Dave", NOW - HOUR),
      reminder("Order bar oil", NOW + 2 * HOUR),
      reminder("Renew the rego", NOW + 10 * 24 * HOUR),
      reminder("Undated thought"),
    ],
  },
  tasks: { listTasks: async () => [task("Quote the deck"), task("Old job", true)] },
  errands: { list: async () => [errand("Milk"), errand("Screws", "done")] },
};

async function rundown(src: AuthoritativeVoiceQuerySources) {
  return createAuthoritativeVoiceQueries(src).answer({
    commandId: DAILY_RUNDOWN_COMMAND_ID,
    now: NOW,
  });
}

describe("voice daily rundown phrases", () => {
  it("matches the fixed rundown phrases on the client profile only", () => {
    for (const phrase of [
      "give me the rundown",
      "Give me the rundown, please.",
      "rundown",
      "brief me",
      "morning brief",
      "What's my day look like?",
      "What’s my day looking like",
      "how's my day looking",
      "what have I got on today",
      "run me through my day",
    ]) {
      assert.equal(matchVoiceRundown(phrase, "client")?.id, DAILY_RUNDOWN_COMMAND_ID, phrase);
    }
    assert.equal(matchVoiceRundown("give me the rundown", "workshop"), undefined);
  });

  it("never matches fuzzily, and leaves the catalog and dictation alone", () => {
    for (const phrase of [
      "what is on today", // the catalog's jobs-only schedule query
      "give me the rundown and send the quote",
      "rundown of the smith job",
      "brief me on the fence",
      "add a task: give me the rundown",
    ]) {
      assert.equal(matchVoiceRundown(phrase, "client"), undefined, phrase);
    }
    assert.equal(
      VOICE_COMMANDS.find((entry) => entry.id === DAILY_RUNDOWN_COMMAND_ID),
      undefined,
    );
    assert.equal(
      parseVoiceDictation("add a task: give me the rundown", "client")?.command.id,
      "client.capture-task",
    );
  });
});

describe("voice daily rundown answer", () => {
  it("reads today's jobs, reminders due and coming up, open tasks and open errands", async () => {
    assert.deepEqual(await rundown(sources(FULL_DAY)), {
      status: "answered",
      answer:
        "Here's your day. One job booked: Smith fence. " +
        "One reminder's overdue: Call Dave. Coming up: Order bar oil, today at 1:30 pm. " +
        "One task on your list: Quote the deck. One errand to run: Milk.",
    });
  });

  it("says plainly when the day is clear", async () => {
    assert.deepEqual(
      await rundown(
        sources({
          projects: { list: async () => [] },
          reminders: { listReminders: async () => [reminder("Later", NOW + 10 * 24 * HOUR)] },
          tasks: { listTasks: async () => [] },
          errands: { list: async () => [] },
        }),
      ),
      {
        status: "answered",
        answer:
          "You're all clear today. No jobs booked, nothing on your list, no errands and no reminders coming up.",
      },
    );
  });

  it("names a source it cannot read instead of guessing, and keeps the rest", async () => {
    const result = await rundown(
      sources({ ...FULL_DAY, reminders: { listReminders: boom("reminders") } }),
    );
    assert.equal(result.status, "answered");
    assert.ok(result.status === "answered");
    assert.match(result.answer, /Reminder records are unavailable\./);
    assert.doesNotMatch(result.answer, /No reminders|no reminders|0 reminder/);
    assert.match(result.answer, /One job booked: Smith fence\./);
    assert.match(result.answer, /One errand to run: Milk\./);
  });

  it("is unavailable when nothing can be read or the timezone is invalid", async () => {
    assert.deepEqual(await rundown(sources()), {
      status: "unavailable",
      reason: "The daily rundown is unavailable: no source could be read.",
    });
    const badZone = await rundown(sources({ ...FULL_DAY, timezone: "Not/AZone" }));
    assert.equal(badZone.status, "unavailable");
  });
});

describe("voice daily rundown in the session", () => {
  function session() {
    return new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      queries: createAuthoritativeVoiceQueries(sources(FULL_DAY)),
    });
  }

  it("answers a wake-authorised rundown phrase and arms nothing", async () => {
    const s = session();
    const out = await s.handle({
      transcript: "give me the rundown",
      isFinal: true,
      wakeAuthorized: true,
      now: NOW,
    });
    assert.equal(out.decision, "answered");
    assert.ok(out.decision === "answered");
    assert.equal(out.command.id, DAILY_RUNDOWN_COMMAND_ID);
    assert.match(out.answer, /^Here's your day\./);
    assert.equal(s.pending(), undefined);
  });

  it("does nothing for unwoken speech", async () => {
    const out = await session().handle({
      transcript: "give me the rundown",
      isFinal: true,
      now: NOW,
    });
    assert.equal(out.decision, "unrecognized");
  });

  it("a rundown replaces an earlier pending read-back", async () => {
    const s = session();
    await s.handle({
      transcript: "add a task: order bar oil",
      isFinal: true,
      wakeAuthorized: true,
      now: NOW,
    });
    assert.ok(s.pending());
    await s.handle({ transcript: "brief me", isFinal: true, wakeAuthorized: true, now: NOW + 1 });
    assert.equal(s.pending(), undefined);
    const confirm = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: NOW + 2,
    });
    assert.equal(confirm.decision, "confirmation-not-pending");
  });
});

describe("voice daily rundown, partly empty", () => {
  it("names only what is on and rolls the rest into one sentence", async () => {
    const result = await rundown(
      sources({
        ...FULL_DAY,
        projects: { list: async () => [] },
        errands: { list: async () => [] },
      }),
    );
    assert.ok(result.status === "answered");
    assert.match(result.answer, /One task on your list: Quote the deck\. No jobs or errands\.$/);
  });
});
