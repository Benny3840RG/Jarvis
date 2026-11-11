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
