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
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
});

it("binds capture to awaiting-confirmation/proposed on the two safe-write commands", () => {
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
  const taskCapture = { title: "Order oil", category: "work" };
  const reminderCapture = { title: "Call Dave" };

  for (const decision of ["awaiting-confirmation", "proposed"]) {
    for (const value of [
      { decision, command: task, capture: taskCapture },
      { decision, command: reminder, capture: reminderCapture },
    ])
      assert.equal(validateDispatch(value), true, JSON.stringify(validateDispatch.errors));
  }
  for (const value of [
    { decision: "answered", capture: { title: "X" } },
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
    {
      ...pending,
      command: command(reminder.id, { tool: "reminders", operation: "delete" }),
      capture: reminderCapture,
    },
  ])
    assert.equal(validatePending(value), false, JSON.stringify(value));
});
