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
  const command = (id: string) => ({
    id,
    profile: "client",
    phrases: ["x"],
    summary: "s",
    kind: "propose",
    criticality: "routine",
    requiresSpokenConfirmation: false,
  });
  const task = command("client.capture-task");
  const reminder = command("client.follow-up-reminder");
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
    { decision: "awaiting-confirmation", command: task, capture: reminderCapture },
    { decision: "awaiting-confirmation", command: reminder, capture: taskCapture },
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
    { ...pending, command: task, capture: { title: "X" } },
    { ...pending, command: reminder, capture: { title: "X", category: "work" } },
    { ...pending, command: command("client.status"), capture: reminderCapture },
  ])
    assert.equal(validatePending(value), false, JSON.stringify(value));
});
