import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Asset } from "../src/assets/asset.js";
import type { Build } from "../src/builds/build.js";
import type { Enquiry } from "../src/enquiries/enquiry.js";
import type { Errand } from "../src/errands/errand.js";
import type { Invoice } from "../src/invoices/invoice.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import type { Project } from "../src/projects/project.js";
import type { Quote } from "../src/quotes/quote.js";
import {
  createAuthoritativeVoiceQueries,
  type AuthoritativeVoiceQuerySources,
} from "../src/voice/authoritativeVoiceQuery.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import type { VoiceQueryProvider } from "../src/voice/voiceQuery.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

const NOW = Date.parse("2026-10-07T00:30:00.000Z");
const DAY = 86_400_000;

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

async function ask(src: AuthoritativeVoiceQuerySources, commandId: string, now = NOW) {
  return createAuthoritativeVoiceQueries(src).answer({ commandId, now });
}

function project(
  title: string,
  scheduledFor?: string,
  status: Project["status"] = "active",
  updatedAt = 1,
): Project {
  return {
    id: title,
    clientId: "c1",
    title,
    status,
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
    createdAt: 1,
    updatedAt,
  };
}

function invoice(
  number: string,
  status: Invoice["status"],
  total: number,
  issuedAt?: number,
): Invoice {
  return {
    id: number,
    clientId: "c1",
    number,
    status,
    lineItems: [{ description: "Work", quantity: 1, unitPrice: total }],
    subtotal: total,
    tax: 0,
    total,
    amountPaid: 0,
    balanceDue: status === "issued" ? total : 0,
    paymentStatus: "unpaid",
    payments: [],
    ...(issuedAt === undefined ? {} : { issuedAt }),
    createdAt: issuedAt ?? 1,
    updatedAt: 1,
  };
}

function enquiry(work: string, urgency: Enquiry["urgency"], createdAt: number): Enquiry {
  return {
    id: work,
    clientId: "c1",
    source: "phone",
    requestedWork: work,
    urgency,
    attachmentRefs: [],
    status: "open",
    createdAt,
    updatedAt: createdAt,
  };
}

function quote(number: string, status: Quote["status"], updatedAt: number): Quote {
  return {
    id: number,
    clientId: "c1",
    number,
    status,
    lineItems: [],
    subtotal: 10,
    tax: 0,
    total: 10,
    createdAt: 1,
    updatedAt,
  };
}

function task(title: string, completed: boolean, createdAt: number): Task {
  return { id: title, title, completed, category: "home", createdAt };
}

function reminder(title: string, dueAt?: number): Reminder {
  return {
    id: title,
    title,
    ...(dueAt === undefined ? {} : { dueAt }),
    createdAt: 1,
  };
}

function errand(title: string, status: Errand["status"], label?: string): Errand {
  return {
    id: title,
    title,
    status,
    ...(label === undefined ? {} : { location: { label } }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function asset(name: string, serviceIntervalDays?: number, lastServicedAt?: number): Asset {
  return {
    id: name,
    name,
    kind: "tool",
    ...(serviceIntervalDays === undefined ? {} : { serviceIntervalDays }),
    ...(lastServicedAt === undefined ? {} : { lastServicedAt }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function build(name: string, kind: string, status: Build["status"]): Build {
  return { id: name, name, kind, status, createdAt: 1, updatedAt: 1 };
}

describe("authoritative voice queries", () => {
  it("reports jobs today from the daily brief, excluding done jobs", async () => {
    const result = await ask(
      sources({
        projects: {
          list: async () => [
            project("Done today", "2026-10-07", "done"),
            project("Hedge", "2026-10-07"),
            project("Next week", "2026-10-12"),
          ],
        },
      }),
      "client.todays-schedule",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "1 job booked for today. Hedge.",
    });
  });

  it("reports no jobs today when the register is healthy and empty", async () => {
    const result = await ask(
      sources({ projects: { list: async () => [] } }),
      "client.todays-schedule",
    );
    assert.deepEqual(result, { status: "answered", answer: "No jobs booked for today." });
  });

  it("names project records when today's jobs cannot be read", async () => {
    const result = await ask(sources(), "client.todays-schedule");
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.reason, "Project records are unavailable.");
      assert.doesNotMatch(result.reason, /No jobs|0 job/);
    }
  });

  it("reports today and later this week from the brief slices", async () => {
    const result = await ask(
      sources({
        projects: {
          list: async () => [
            project("Hedge", "2026-10-07"),
            project("Deck", "2026-10-09"),
            project("Next week", "2026-10-12"),
          ],
        },
      }),
      "client.jobs-this-week",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer:
        "1 job booked for today. 1 job booked later this week. Today: Hedge. Later this week: Deck.",
    });
  });

  it("reports no jobs this week when none are booked in the brief window", async () => {
    const result = await ask(
      sources({ projects: { list: async () => [project("Next week", "2026-10-12")] } }),
      "client.jobs-this-week",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "No jobs booked today or later this week.",
    });
  });

  it("names project records when this week's jobs cannot be read", async () => {
    const result = await ask(sources(), "client.jobs-this-week");
    assert.deepEqual(result, { status: "unavailable", reason: "Project records are unavailable." });
  });

  it("reads the next booked job, including one after this week", async () => {
    const result = await ask(
      sources({
        projects: {
          list: async () => [
            project("Overdue", "2026-10-06"),
            project("Done", "2026-10-07", "done"),
            project("Later", "2026-10-12"),
          ],
        },
      }),
      "workshop.next-job",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "Next job is Later, booked for 2026-10-12.",
    });
  });

  it("reports no upcoming job when nothing is booked ahead", async () => {
    const result = await ask(
      sources({ projects: { list: async () => [project("Overdue", "2026-10-01")] } }),
      "workshop.next-job",
    );
    assert.deepEqual(result, { status: "answered", answer: "No upcoming job is booked." });
  });

  it("names project records when the next job cannot be read", async () => {
    const result = await ask(sources(), "workshop.next-job");
    assert.deepEqual(result, { status: "unavailable", reason: "Project records are unavailable." });
  });

  it("reads the next appointment without inventing a time", async () => {
    const result = await ask(
      sources({ projects: { list: async () => [project("Hedge", "2026-10-07")] } }),
      "client.next-appointment",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "Next appointment is Hedge, booked for 2026-10-07. No appointment time is recorded.",
    });
  });

  it("reports no upcoming appointment when none is booked", async () => {
    const result = await ask(
      sources({ projects: { list: async () => [] } }),
      "client.next-appointment",
    );
    assert.deepEqual(result, { status: "answered", answer: "No upcoming appointment is booked." });
  });

  it("names timezone configuration when a schedule cannot be dated", async () => {
    let reads = 0;
    const result = await ask(
      sources({
        timezone: "Not/AZone",
        projects: {
          list: async () => {
            reads += 1;
            return [project("Hedge", "2026-10-07")];
          },
        },
      }),
      "client.todays-schedule",
    );
    assert.equal(reads, 0);
    assert.deepEqual(result, {
      status: "unavailable",
      reason: "Jarvis timezone configuration is unavailable.",
    });
  });

  it("counts issued invoices with a balance and ignores drafts", async () => {
    const result = await ask(
      sources({
        invoices: {
          list: async () => [
            invoice("INV-b", "issued", 10.5, 2),
            invoice("INV-draft", "draft", 99),
            invoice("INV-a", "issued", 40, 1),
          ],
        },
      }),
      "client.unpaid-invoices",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "2 unpaid invoices, balance due 50.50. INV-a; INV-b.",
    });
  });

  it("reports no unpaid invoices when the register is healthy and empty", async () => {
    const result = await ask(
      sources({ invoices: { list: async () => [] } }),
      "client.unpaid-invoices",
    );
    assert.deepEqual(result, { status: "answered", answer: "No unpaid invoices." });
  });

  it("names invoice records when unpaid invoices cannot be read", async () => {
    const result = await ask(sources(), "client.unpaid-invoices");
    assert.deepEqual(result, { status: "unavailable", reason: "Invoice records are unavailable." });
  });

  it("counts open enquiries from the same open filter the brief uses", async () => {
    let filter: unknown;
    const result = await ask(
      sources({
        enquiries: {
          list: async (input) => {
            filter = input;
            return [
              { ...enquiry("Fence", "standard", 1), status: "closed" },
              enquiry("Burst pipe", "emergency", 2),
              enquiry("Fence", "standard", 1),
            ];
          },
        },
      }),
      "client.open-enquiries",
    );
    assert.deepEqual(filter, { status: "open" });
    assert.deepEqual(result, {
      status: "answered",
      answer: "2 open enquiries. Burst pipe; Fence.",
    });
  });

  it("reports no open enquiries when the register is healthy and empty", async () => {
    const result = await ask(
      sources({ enquiries: { list: async () => [] } }),
      "client.open-enquiries",
    );
    assert.deepEqual(result, { status: "answered", answer: "No open enquiries." });
  });

  it("names enquiry records when open enquiries cannot be read", async () => {
    const result = await ask(sources(), "client.open-enquiries");
    assert.deepEqual(result, { status: "unavailable", reason: "Enquiry records are unavailable." });
  });

  it("keeps quote follow-up unavailable until the governed owner-wide read exists", async () => {
    let reads = 0;
    const result = await ask(
      sources({
        quotes: {
          list: async () => {
            reads += 1;
            return [quote("Q-1", "sent", 1)];
          },
        },
      }),
      "client.quote-follow-up",
    );
    assert.equal(reads, 0);
    assert.deepEqual(result, {
      status: "unavailable",
      reason:
        "Quote follow-up is unavailable: no owner-wide governed sent-quote read (lifecycle delivery ledger) is connected. The daily-brief quote file is not that register.",
    });
  });

  it("does not treat an empty or draft-only flat quote file as no follow-up", async () => {
    let reads = 0;
    const flat = (rows: Quote[]) => ({
      list: async () => {
        reads += 1;
        return rows;
      },
    });
    const files = [flat([]), flat([quote("Q-1", "draft", 1)])];
    for (const quotes of files) {
      const result = await ask(sources({ quotes }), "client.quote-follow-up");
      assert.deepEqual(result, {
        status: "unavailable",
        reason:
          "Quote follow-up is unavailable: no owner-wide governed sent-quote read (lifecycle delivery ledger) is connected. The daily-brief quote file is not that register.",
      });
      if (result.status === "unavailable") {
        assert.doesNotMatch(result.reason, /no quotes awaiting a response/i);
      }
    }
    assert.equal(reads, 0);
  });

  it("reads open tasks and ignores completed ones", async () => {
    const result = await ask(
      sources({
        tasks: {
          listTasks: async () => [task("Done", true, 1), task("Mow", false, 2)],
        },
      }),
      "client.open-tasks",
    );
    assert.deepEqual(result, { status: "answered", answer: "1 open task. Mow." });
  });

  it("reports no open tasks when the register is healthy and empty", async () => {
    const result = await ask(
      sources({ tasks: { listTasks: async () => [] } }),
      "client.open-tasks",
    );
    assert.deepEqual(result, { status: "answered", answer: "No open tasks." });
  });

  it("names task records when tasks cannot be read", async () => {
    const result = await ask(sources(), "client.open-tasks");
    assert.deepEqual(result, { status: "unavailable", reason: "Task records are unavailable." });
  });

  it("reads due, upcoming and undated reminders", async () => {
    const result = await ask(
      sources({
        reminders: {
          listReminders: async () => [
            reminder("Soon", NOW + 1_000),
            reminder("Due one", NOW - 1),
            reminder("Undated"),
          ],
        },
      }),
      "client.reminders",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "1 reminder due, 1 upcoming, 1 undated. Due: Due one. Upcoming: Soon.",
    });
  });

  it("reports reminders scheduled beyond the brief upcoming window", async () => {
    const result = await ask(
      sources({
        reminders: {
          listReminders: async () => [reminder("Later", NOW + 2 * DAY)],
        },
      }),
      "client.reminders",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "0 reminders due, 0 upcoming, 0 undated. 1 reminder scheduled later.",
    });
  });

  it("reports no reminders when the register is healthy and empty", async () => {
    const result = await ask(
      sources({ reminders: { listReminders: async () => [] } }),
      "client.reminders",
    );
    assert.deepEqual(result, { status: "answered", answer: "No reminders." });
  });

  it("names reminder records when reminders cannot be read", async () => {
    const result = await ask(sources(), "client.reminders");
    assert.deepEqual(result, {
      status: "unavailable",
      reason: "Reminder records are unavailable.",
    });
  });

  it("reads open errands and ignores done ones", async () => {
    const result = await ask(
      sources({
        errands: {
          list: async () => [errand("Silicone", "open", "Bunnings"), errand("Milk", "done")],
        },
      }),
      "client.open-errands",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "1 open errand. Silicone at Bunnings.",
    });
  });

  it("reports no open errands when the register is healthy and empty", async () => {
    const result = await ask(sources({ errands: { list: async () => [] } }), "client.open-errands");
    assert.deepEqual(result, { status: "answered", answer: "No open errands." });
  });

  it("names errand records when errands cannot be read", async () => {
    const result = await ask(sources(), "client.open-errands");
    assert.deepEqual(result, { status: "unavailable", reason: "Errand records are unavailable." });
  });

  it("reads workshop builds in store order", async () => {
    const result = await ask(
      sources({
        builds: {
          list: async () => [
            build("Rex", "RC crawler", "active"),
            build("Gull", "trailer", "planning"),
          ],
        },
      }),
      "workshop.builds",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "2 workshop builds. Rex is active; Gull is planning.",
    });
  });

  it("reports no workshop builds when the register is healthy and empty", async () => {
    const result = await ask(sources({ builds: { list: async () => [] } }), "workshop.builds");
    assert.deepEqual(result, { status: "answered", answer: "No workshop builds are recorded." });
  });

  it("names build records when builds cannot be read", async () => {
    const result = await ask(sources(), "workshop.builds");
    assert.deepEqual(result, { status: "unavailable", reason: "Build records are unavailable." });
  });

  it("reads workshop assets", async () => {
    const result = await ask(
      sources({ assets: { list: async () => [asset("Mower"), asset("Saw")] } }),
      "workshop.assets",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "2 workshop assets. Mower; Saw.",
    });
  });

  it("reports no workshop assets when the register is healthy and empty", async () => {
    const result = await ask(sources({ assets: { list: async () => [] } }), "workshop.assets");
    assert.deepEqual(result, { status: "answered", answer: "No workshop assets are recorded." });
  });

  it("names asset records when assets cannot be read", async () => {
    const result = await ask(sources(), "workshop.assets");
    assert.deepEqual(result, { status: "unavailable", reason: "Asset records are unavailable." });
  });

  it("reads maintenance due and due soon from asset service dates", async () => {
    const result = await ask(
      sources({
        assets: {
          list: async () => [
            asset("Mower", 7, NOW - 10 * DAY),
            asset("Compressor", 10, NOW - DAY),
            asset("Bench"),
          ],
        },
      }),
      "workshop.maintenance",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "1 asset overdue for service, 1 due soon. Overdue: Mower. Due soon: Compressor.",
    });
  });

  it("reports no maintenance when no asset is due", async () => {
    const result = await ask(
      sources({ assets: { list: async () => [asset("Bench")] } }),
      "workshop.maintenance",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer: "No maintenance is due or due soon.",
    });
  });

  it("names asset records when maintenance cannot be read", async () => {
    const result = await ask(sources(), "workshop.maintenance");
    assert.deepEqual(result, { status: "unavailable", reason: "Asset records are unavailable." });
  });

  it("reports recorded crawler status and keeps live hardware unavailable", async () => {
    const result = await ask(
      sources({
        builds: {
          list: async () => [
            build("Not a crawler", "bench", "active"),
            build("Rex", "RC crawler", "active"),
          ],
        },
      }),
      "crawler.status",
    );
    assert.deepEqual(result, {
      status: "answered",
      answer:
        "Recorded crawler status: Rex is active. Live crawler hardware status is unavailable: no commissioned hardware-status source is connected.",
    });
  });

  it("reports no recorded crawler status without inventing a position", async () => {
    const result = await ask(sources({ builds: { list: async () => [] } }), "crawler.status");
    assert.equal(result.status, "answered");
    if (result.status === "answered") {
      assert.match(result.answer, /No recorded crawler status/);
      assert.match(result.answer, /Live crawler hardware status is unavailable/);
      assert.doesNotMatch(result.answer, /position|available at|percent/i);
    }
  });

  it("names build records when crawler status cannot be read", async () => {
    const result = await ask(sources(), "crawler.status");
    assert.deepEqual(result, { status: "unavailable", reason: "Build records are unavailable." });
  });

  it("reports recorded trailer status from the build kind", async () => {
    const result = await ask(
      sources({ builds: { list: async () => [build("Gull", "gull-wing trailer", "planning")] } }),
      "trailer.status",
    );
    assert.equal(result.status, "answered");
    if (result.status === "answered") {
      assert.match(result.answer, /Recorded trailer status: Gull is planning/);
      assert.match(result.answer, /Live trailer hardware status is unavailable/);
    }
  });

  it("reports no recorded trailer status when none is stored", async () => {
    const result = await ask(sources({ builds: { list: async () => [] } }), "trailer.status");
    assert.equal(result.status, "answered");
    if (result.status === "answered") {
      assert.match(result.answer, /No recorded trailer status/);
    }
  });

  it("names build records when trailer status cannot be read", async () => {
    const result = await ask(sources(), "trailer.status");
    assert.deepEqual(result, { status: "unavailable", reason: "Build records are unavailable." });
  });

  it("keeps uncommissioned workshop equipment unavailable and does not read stores", async () => {
    const result = await ask(sources(), "workshop.status");
    assert.deepEqual(result, {
      status: "unavailable",
      reason:
        "Workshop equipment status is unavailable: no commissioned equipment-status source is connected.",
    });
  });

  it("does not invent an answer for a query with no bound read", async () => {
    const result = await ask(sources(), "client.unknown");
    assert.deepEqual(result, {
      status: "unavailable",
      reason: "No authoritative read is bound for this voice command.",
    });
  });
});

describe("voice session query dispatch", () => {
  it("returns the provider answer and does not consult hardware", async () => {
    let hardwareReads = 0;
    const queries: VoiceQueryProvider = {
      answer: async () => ({ status: "answered", answer: "No unpaid invoices." }),
    };
    const session = new VoiceSession({
      profile: "client",
      provider: {
        statusOf: () => {
          hardwareReads += 1;
          return "unavailable";
        },
        actuate: () => Promise.reject(new Error("queries must not actuate")),
      },
      queries,
    });
    const dispatch = await session.handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: NOW,
    });
    assert.equal(hardwareReads, 0);
    assert.deepEqual(dispatch, {
      decision: "answered",
      command: dispatch.decision === "answered" ? dispatch.command : undefined,
      answer: "No unpaid invoices.",
    });
    if (dispatch.decision === "answered")
      assert.equal(dispatch.command.id, "client.unpaid-invoices");
  });

  it("keeps a disconnected provider explicitly unavailable", async () => {
    const session = new VoiceSession({ profile: "client", provider: new AbsentHardwareProvider() });
    const dispatch = await session.handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(dispatch.decision, "query-unavailable");
  });

  it("names a provider failure instead of inventing an answer", async () => {
    const session = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      queries: {
        answer: () => Promise.reject(new Error("boom")),
      },
    });
    const dispatch = await session.handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(dispatch.decision, "query-unavailable");
    if (dispatch.decision === "query-unavailable") {
      assert.match(dispatch.reason, /failed before returning an authoritative answer/);
    }
  });

  it("rejects an empty answer instead of speaking silence as success", async () => {
    const session = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      queries: { answer: async () => ({ status: "answered", answer: "   " }) },
    });
    const dispatch = await session.handle({
      transcript: "any unpaid invoices",
      isFinal: true,
      now: 0,
    });
    assert.equal(dispatch.decision, "query-unavailable");
  });
});
