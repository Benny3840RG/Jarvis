import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderOwnerDecisionsPage } from "../src/ownerGate/ownerDecisionPage.js";

type Result = { textContent: string };
type Decide = (
  card: unknown,
  choice: string,
  idempotencyKey: string,
  confirmField: null,
  note: { value: string },
  buttons: Array<{ disabled: boolean }>,
  result: Result,
) => Promise<void>;

// Runs the page's own decide() with a fetch that answers the click and then a
// reload that redraws every card, the way render() replaces them in a browser.
function decideWith(click: { ok: boolean; status: number; body: unknown }): {
  decide: Decide;
  shown: () => string;
} {
  const source = renderOwnerDecisionsPage().match(
    /async function decide\(card[\s\S]*?\n {4}\}\n/,
  )?.[0];
  assert.ok(source, "missing decide()");
  let redrawn: Result = { textContent: "" };
  const load = async () => {
    redrawn = { textContent: "" };
  };
  const fetch = async () => ({ ok: click.ok, status: click.status, json: async () => click.body });
  const document = { querySelector: () => redrawn };
  const decide = new Function(
    "serviceToken",
    "approvalToken",
    "load",
    "fetch",
    "document",
    `${source}; return decide;`,
  )({ value: "service" }, { value: "approval" }, load, fetch, document) as Decide;
  return { decide, shown: () => redrawn.textContent };
}

const card = { actionDigest: "digest", entry: { id: "voice-host-commissioning" } };

describe("owner decision page script", () => {
  it("keeps a refusal on screen after the queue redraws", async () => {
    const { decide, shown } = decideWith({
      ok: false,
      status: 401,
      body: { detail: "A valid Bearer service token is required." },
    });
    await decide(card, "approve", "key", null, { value: "" }, [], { textContent: "" });
    assert.equal(shown(), "A valid Bearer service token is required. Nothing was recorded.");
  });

  it("still says when a decision was recorded", async () => {
    const { decide, shown } = decideWith({
      ok: true,
      status: 201,
      body: { data: { replayed: false } },
    });
    await decide(card, "approve", "key", null, { value: "" }, [], { textContent: "" });
    assert.match(shown(), /^Recorded\./);
  });
});
