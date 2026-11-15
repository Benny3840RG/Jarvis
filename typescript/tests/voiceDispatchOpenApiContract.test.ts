import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

it("validates inferred voice dispatch metadata against its decision and confidence range", () => {
  const document = JSON.parse(
    readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020.default({ strict: false }).compile({
    ...document.components.schemas.VoiceDispatch,
    components: document.components,
  });
  for (const value of [
    { decision: "awaiting-confirmation" },
    { decision: "awaiting-confirmation", inferred: true, confidence: 0 },
    { decision: "awaiting-confirmation", inferred: true, confidence: 1 },
    { decision: "unrecognized" },
    { decision: "conversation", reply: "G'day." },
    { decision: "conversation-unavailable", conversationReason: "provider-error" },
    { decision: "conversation-unavailable", conversationReason: "ungrounded" },
    { decision: "conversation-unavailable", conversationReason: "reply-too-long" },
    // The largest reply JARVIS_VOICE_CONVERSATION_MAX_REPLY_CHARS may permit.
    { decision: "conversation", reply: "a".repeat(2000) },
    {
      decision: "completion-unresolved",
      command: {
        id: "client.complete-item",
        profile: "client",
        phrases: [],
        summary: "s",
        kind: "propose",
        criticality: "routine",
        requiresSpokenConfirmation: false,
      },
      reason: "No open task or errand matches “Sprocket”.",
    },
    {
      decision: "completion-unresolved",
      command: {
        id: "client.cancel-reminder",
        profile: "client",
        phrases: [],
        summary: "s",
        kind: "propose",
        criticality: "routine",
        requiresSpokenConfirmation: false,
        proposes: { tool: "reminders", operation: "cancel" },
      },
      reason: "No reminder matches “Sprocket”.",
    },
  ])
    assert.equal(validate(value), true, JSON.stringify(value));
  for (const value of [
    { decision: "awaiting-confirmation", inferred: true },
    { decision: "awaiting-confirmation", confidence: 0.5 },
    { decision: "awaiting-confirmation", inferred: true, confidence: -0.1 },
    { decision: "awaiting-confirmation", inferred: true, confidence: 1.1 },
    { decision: "awaiting-confirmation", inferred: true, confidence: "0.5" },
    { decision: "unrecognized", inferred: true, confidence: 0.5 },
    { decision: "unrecognized", confidence: 0.5 },
    { decision: "conversation" },
    { decision: "conversation-unavailable", conversationReason: "secret provider error" },
    { decision: "unrecognized", reply: "No." },
    { decision: "conversation", reply: "a".repeat(2001) },
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
});

it("binds capture to awaiting-confirmation/proposed on the three safe-write commands", () => {
  const document = JSON.parse(
    readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
  );
  const compile = (name: string) =>
    new Ajv2020.default({ strict: false }).compile({
      ...document.components.schemas[name],
      components: document.components,
    });
  const validateDispatch = compile("VoiceDispatch");
  const validatePending = compile("VoicePendingConfirmation");
  const command = (
    id: string,
    proposes?: { tool: string; operation: string },
    kind = "propose",
  ) => ({
    id,
    profile: "client",
    phrases: ["x"],
    summary: "s",
    kind,
    criticality: "routine",
    requiresSpokenConfirmation: false,
    ...(proposes ? { proposes } : {}),
  });
  const withoutProfile = ({ profile: _profile, ...rest }: ReturnType<typeof command>) => rest;
  const task = command("client.capture-task", { tool: "tasks", operation: "create" });
  const reminder = command("client.follow-up-reminder", { tool: "reminders", operation: "create" });
  const errand = command("client.capture-errand", { tool: "errands", operation: "create" });
  const completeTask = command("client.complete-task", { tool: "tasks", operation: "complete" });
  const completeErrand = command("client.complete-errand", {
    tool: "errands",
    operation: "complete",
  });
  const cancelReminder = command("client.cancel-reminder", {
    tool: "reminders",
    operation: "cancel",
  });
  const removeErrand = command("client.remove-errand", { tool: "errands", operation: "remove" });
  const rescheduleReminder = command("client.reschedule-reminder", {
    tool: "reminders",
    operation: "reschedule",
  });
  const rescheduleCapture = {
    title: "Order bar oil",
    targetId: "r1",
    dueRaw: "friday at 9 am",
    dueAt: 1_795_125_600_000,
    dueTimezone: "Australia/Sydney",
  };
  const completionCapture = { title: "Order bar oil", targetId: "t1" };
  const taskCapture = { title: "Order oil", category: "work" };
  const reminderCapture = { title: "Call Dave" };
  const datedReminderCapture = {
    title: "Call Dave",
    dueRaw: "tomorrow at 7 am",
    dueAt: 1_763_236_800_000,
    dueTimezone: "Australia/Melbourne",
  };

  for (const decision of ["awaiting-confirmation", "proposed"]) {
    for (const value of [
      { decision, command: task, capture: taskCapture },
      { decision, command: reminder, capture: reminderCapture },
      { decision, command: reminder, capture: datedReminderCapture },
      { decision, command: reminder, capture: { title: "Pay rego", dueRaw: "by friday" } },
      { decision, command: errand, capture: { title: "Silicone for the deck" } },
      { decision, command: completeTask, capture: completionCapture },
      { decision, command: completeErrand, capture: { title: "Milk", targetId: "e1" } },
      { decision, command: cancelReminder, capture: { title: "Call Dave", targetId: "r1" } },
      { decision, command: removeErrand, capture: { title: "Milk", targetId: "e1" } },
      { decision, command: rescheduleReminder, capture: rescheduleCapture },
      {
        decision,
        command: rescheduleReminder,
        capture: { title: "Order bar oil", targetId: "r1", dueRaw: "friday" },
      },
    ])
      assert.equal(validateDispatch(value), true, JSON.stringify(validateDispatch.errors));
  }
  for (const value of [
    { decision: "answered", capture: { title: "X" } },
    // Due fields belong to reminders only, and a resolved time is always paired.
    { decision: "proposed", command: task, capture: { ...taskCapture, dueRaw: "tomorrow" } },
    { decision: "proposed", command: reminder, capture: { title: "X", dueAt: 1 } },
    { decision: "proposed", command: reminder, capture: { title: "X", dueTimezone: "UTC" } },
    {
      decision: "proposed",
      command: reminder,
      capture: { title: "X", dueAt: 1, dueTimezone: "UTC" },
    },
    { decision: "answered", command: task, capture: taskCapture },
    { decision: "unrecognized", capture: taskCapture },
    { decision: "ambiguous", command: task, capture: taskCapture },
    { decision: "cancelled", command: task, capture: taskCapture },
    { decision: "proposed", capture: taskCapture },
    { decision: "proposed", command: task, capture: { title: "X" } },
    { decision: "proposed", command: reminder, capture: { title: "X", category: "work" } },
    { decision: "proposed", command: command("client.status"), capture: reminderCapture },
    // A captured dictation is never inferred and carries no interpreter confidence.
    { decision: "awaiting-confirmation", command: task, capture: taskCapture, inferred: true },
    { decision: "awaiting-confirmation", command: task, capture: taskCapture, confidence: 0.5 },
    {
      decision: "awaiting-confirmation",
      command: reminder,
      capture: reminderCapture,
      inferred: true,
      confidence: 0.5,
    },
    // Exact safe-write command shape: kind propose and the matching operation.
    {
      decision: "proposed",
      command: command(task.id, task.proposes, "query"),
      capture: taskCapture,
    },
    { decision: "proposed", command: command(task.id, undefined), capture: taskCapture },
    {
      decision: "proposed",
      command: command(task.id, { tool: "reminders", operation: "create" }),
      capture: taskCapture,
    },
    {
      decision: "proposed",
      command: command(task.id, { tool: "tasks", operation: "update" }),
      capture: taskCapture,
    },
    {
      decision: "proposed",
      command: command(reminder.id, reminder.proposes, "actuate"),
      capture: reminderCapture,
    },
    {
      decision: "proposed",
      command: command(reminder.id, { tool: "tasks", operation: "create" }),
      capture: reminderCapture,
    },
    { decision: "awaiting-confirmation", command: task, capture: reminderCapture },
    { decision: "awaiting-confirmation", command: reminder, capture: taskCapture },
    // An errand carries only its title, on the governed errands:create executor.
    { decision: "proposed", command: errand, capture: taskCapture },
    { decision: "proposed", command: errand, capture: { title: "X", dueRaw: "tomorrow" } },
    { decision: "proposed", command: errand, capture: datedReminderCapture },
    {
      decision: "proposed",
      command: command(errand.id, { tool: "create_errand", operation: "errands:create" }),
      capture: { title: "X" },
    },
    { decision: "proposed", command: command(errand.id), capture: { title: "X" } },
    { decision: "proposed", command: withoutProfile(errand), capture: { title: "X" } },
    // A completion carries a resolved target and nothing else; a create never does.
    { decision: "proposed", command: completeTask, capture: { title: "X" } },
    {
      decision: "proposed",
      command: completeTask,
      capture: { ...completionCapture, category: "work" },
    },
    {
      decision: "proposed",
      command: completeErrand,
      capture: { ...completionCapture, dueRaw: "x" },
    },
    {
      decision: "proposed",
      command: command(completeTask.id, { tool: "tasks", operation: "create" }),
      capture: completionCapture,
    },
    {
      decision: "proposed",
      command: command(completeErrand.id, { tool: "tasks", operation: "complete" }),
      capture: completionCapture,
    },
    { decision: "proposed", command: task, capture: { ...taskCapture, targetId: "t1" } },
    { decision: "proposed", command: errand, capture: { title: "X", targetId: "e1" } },
    { decision: "proposed", command: reminder, capture: { title: "X", targetId: "r1" } },
    // A reminder cancellation is a resolved target on reminders:cancel, nothing else.
    { decision: "proposed", command: cancelReminder, capture: { title: "Call Dave" } },
    {
      decision: "proposed",
      command: cancelReminder,
      capture: { ...datedReminderCapture, targetId: "r1" },
    },
    {
      decision: "proposed",
      command: command(cancelReminder.id, { tool: "reminders", operation: "create" }),
      capture: completionCapture,
    },
    {
      decision: "proposed",
      command: command(cancelReminder.id, { tool: "reminders", operation: "delete" }),
      capture: completionCapture,
    },
    // An errand removal is a resolved target on errands:remove, nothing else.
    { decision: "proposed", command: removeErrand, capture: { title: "Milk" } },
    {
      decision: "proposed",
      command: removeErrand,
      capture: { ...completionCapture, category: "work" },
    },
    {
      decision: "proposed",
      command: command(removeErrand.id, { tool: "errands", operation: "complete" }),
      capture: completionCapture,
    },
    // A reschedule needs the resolved target and the new due text, never a category.
    { decision: "proposed", command: rescheduleReminder, capture: completionCapture },
    {
      decision: "proposed",
      command: rescheduleReminder,
      capture: { title: "X", dueRaw: "friday" },
    },
    {
      decision: "proposed",
      command: rescheduleReminder,
      capture: { ...rescheduleCapture, category: "work" },
    },
    {
      decision: "proposed",
      command: rescheduleReminder,
      capture: { title: "X", targetId: "r1", dueRaw: "friday", dueAt: 1 },
    },
    {
      decision: "proposed",
      command: command(rescheduleReminder.id, { tool: "reminders", operation: "create" }),
      capture: rescheduleCapture,
    },
    { decision: "completion-unresolved", command: completeTask },
    { decision: "completion-unresolved", command: task, reason: "x" },
    {
      decision: "completion-unresolved",
      command: completeTask,
      reason: "x",
      capture: completionCapture,
    },
    // A captured command must carry profile exactly "client".
    { decision: "proposed", command: { ...task, profile: "nolan" }, capture: taskCapture },
    { decision: "proposed", command: { ...reminder, profile: "owner" }, capture: reminderCapture },
    { decision: "awaiting-confirmation", command: withoutProfile(task), capture: taskCapture },
    {
      decision: "awaiting-confirmation",
      command: withoutProfile(reminder),
      capture: reminderCapture,
    },
  ])
    assert.equal(validateDispatch(value), false, JSON.stringify(value));

  const pending = { issuedAt: 1, expiresAt: 2 };
  for (const value of [
    { ...pending, command: task },
    { ...pending, command: task, capture: taskCapture },
    { ...pending, command: reminder, capture: reminderCapture },
    { ...pending, command: errand, capture: { title: "Bar oil" } },
    { ...pending, command: completeTask, capture: completionCapture },
    { ...pending, command: cancelReminder, capture: completionCapture },
    { ...pending, command: removeErrand, capture: completionCapture },
    { ...pending, command: rescheduleReminder, capture: rescheduleCapture },
  ])
    assert.equal(validatePending(value), true, JSON.stringify(validatePending.errors));
  for (const value of [
    { ...pending, command: { ...task, profile: "nolan" }, capture: taskCapture },
    { ...pending, command: { ...reminder, profile: "owner" }, capture: reminderCapture },
    { ...pending, command: withoutProfile(task), capture: taskCapture },
    { ...pending, command: withoutProfile(reminder), capture: reminderCapture },
    { ...pending, command: task, capture: { title: "X" } },
    { ...pending, command: reminder, capture: { title: "X", category: "work" } },
    { ...pending, command: command("client.status"), capture: reminderCapture },
    { ...pending, command: command(task.id, task.proposes, "query"), capture: taskCapture },
    { ...pending, command: command(task.id), capture: taskCapture },
    {
      ...pending,
      command: command(task.id, { tool: "reminders", operation: "create" }),
      capture: taskCapture,
    },
    {
      ...pending,
      command: command(reminder.id, reminder.proposes, "actuate"),
      capture: reminderCapture,
    },
    { ...pending, command: command(reminder.id), capture: reminderCapture },
    { ...pending, command: errand, capture: taskCapture },
    { ...pending, command: completeErrand, capture: { title: "Milk" } },
    { ...pending, command: cancelReminder, capture: { title: "Call Dave" } },
    { ...pending, command: removeErrand, capture: { title: "Milk" } },
    { ...pending, command: rescheduleReminder, capture: completionCapture },
    { ...pending, command: errand, capture: { title: "Milk", targetId: "e1" } },
    {
      ...pending,
      command: command(errand.id, { tool: "errands", operation: "delete" }),
      capture: { title: "X" },
    },
    {
      ...pending,
      command: command(reminder.id, { tool: "reminders", operation: "delete" }),
      capture: reminderCapture,
    },
  ])
    assert.equal(validatePending(value), false, JSON.stringify(value));
});
