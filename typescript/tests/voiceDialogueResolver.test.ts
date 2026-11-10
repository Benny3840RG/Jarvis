import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveClarification,
  type ClarificationResolution,
} from "../src/voice/voiceDialogueResolver.js";

// Real catalog candidate sets used across the tests.
const WINCH = ["trailer.winch-up", "trailer.winch-down"] as const; // share "winch"
const WINCH_LIGHTS = ["trailer.winch-up", "trailer.lights-on"] as const;
const QUOTES = ["client.draft-quote", "client.send-quote"] as const; // share "quote"
const SEND_ONLY = ["client.send-quote"] as const;

function resolved(r: ClarificationResolution): {
  commandId: string;
  requiresConfirmation: boolean;
} {
  assert.equal(r.status, "resolved");
  if (r.status !== "resolved") throw new Error("unreachable");
  return { commandId: r.commandId, requiresConfirmation: r.requiresConfirmation };
}

test("clarification resolver — behaviour", async (t) => {
  await t.test("resolves an ordinal reference to the offered position", () => {
    assert.equal(
      resolved(
        resolveClarification({ reply: "the first one", candidates: WINCH, profile: "trailer" }),
      ).commandId,
      "trailer.winch-up",
    );
    assert.equal(
      resolved(
        resolveClarification({ reply: "second please", candidates: WINCH, profile: "trailer" }),
      ).commandId,
      "trailer.winch-down",
    );
    assert.equal(
      resolved(
        resolveClarification({ reply: "the last one", candidates: WINCH, profile: "trailer" }),
      ).commandId,
      "trailer.winch-down",
    );
  });

  await t.test("resolves a distinctive content token", () => {
    assert.equal(
      resolved(
        resolveClarification({ reply: "the down one", candidates: WINCH, profile: "trailer" }),
      ).commandId,
      "trailer.winch-down",
    );
    // "send it" distinguishes send-quote from draft-quote; it is guarded.
    const r = resolved(
      resolveClarification({ reply: "send it", candidates: QUOTES, profile: "client" }),
    );
    assert.equal(r.commandId, "client.send-quote");
    assert.equal(r.requiresConfirmation, true);
  });

  await t.test("an explicit selection wins over filler decline words", () => {
    assert.equal(
      resolved(
        resolveClarification({
          reply: "nah the winch up one",
          candidates: WINCH_LIGHTS,
          profile: "trailer",
        }),
      ).commandId,
      "trailer.winch-up",
    );
  });

  await t.test("a bare affirmation closes a single-candidate clarification", () => {
    assert.equal(
      resolved(
        resolveClarification({ reply: "yeah that's it", candidates: SEND_ONLY, profile: "client" }),
      ).commandId,
      "client.send-quote",
    );
  });

  await t.test("a decline without a selection cancels", () => {
    assert.equal(
      resolveClarification({ reply: "nah forget it", candidates: WINCH, profile: "trailer" })
        .status,
      "cancelled",
    );
    assert.equal(
      resolveClarification({ reply: "neither of those", candidates: QUOTES, profile: "client" })
        .status,
      "cancelled",
    );
  });
});

test("clarification resolver — fails closed", async (t) => {
  await t.test("a token shared by several candidates selects none", () => {
    // "winch" belongs to both winch-up and winch-down → not distinctive.
    assert.equal(
      resolveClarification({ reply: "the winch one", candidates: WINCH, profile: "trailer" })
        .status,
      "unresolved",
    );
  });

  await t.test("a reply naming two candidates stays open", () => {
    assert.equal(
      resolveClarification({
        reply: "winch up or lights",
        candidates: WINCH_LIGHTS,
        profile: "trailer",
      }).status,
      "unresolved",
    );
  });

  await t.test("a bare yes to several options does not guess", () => {
    assert.equal(
      resolveClarification({ reply: "yes", candidates: WINCH, profile: "trailer" }).status,
      "unresolved",
    );
  });

  await t.test("an out-of-range ordinal does not resolve", () => {
    assert.equal(
      resolveClarification({ reply: "the third one", candidates: WINCH, profile: "trailer" })
        .status,
      "unresolved",
    );
  });

  await t.test("an interim reply is never resolved", () => {
    assert.equal(
      resolveClarification({
        reply: "the first one",
        candidates: WINCH,
        profile: "trailer",
        isFinal: false,
      }).status,
      "unresolved",
    );
  });

  await t.test("an empty candidate set resolves nothing", () => {
    assert.equal(
      resolveClarification({ reply: "the first one", candidates: [], profile: "trailer" }).status,
      "unresolved",
    );
  });

  await t.test("candidates from another profile are dropped before matching", () => {
    // A client command offered under the trailer profile cannot be resolved.
    assert.equal(
      resolveClarification({
        reply: "send it",
        candidates: ["client.send-quote"],
        profile: "trailer",
      }).status,
      "unresolved",
    );
  });

  await t.test("an unrelated reply leaves the clarification open", () => {
    assert.equal(
      resolveClarification({ reply: "what is the weather", candidates: WINCH, profile: "trailer" })
        .status,
      "unresolved",
    );
  });

  await t.test("a pure negation cancels and never resolves", () => {
    const r = resolveClarification({ reply: "no", candidates: WINCH, profile: "trailer" });
    assert.equal(r.status, "cancelled");
  });
});

test("clarification resolver — safety invariants", async (t) => {
  const replies = [
    "the first one",
    "second",
    "the last",
    "the down one",
    "winch up",
    "send it",
    "draft one",
    "yes",
    "yeah",
    "nah",
    "forget it",
    "neither",
    "the winch one",
    "winch up or lights",
    "the fifth one",
    "what is the weather",
    "do the thing",
    "that one",
  ];
  const sets: ReadonlyArray<{ candidates: readonly string[]; profile: "trailer" | "client" }> = [
    { candidates: WINCH, profile: "trailer" },
    { candidates: WINCH_LIGHTS, profile: "trailer" },
    { candidates: QUOTES, profile: "client" },
    { candidates: SEND_ONLY, profile: "client" },
  ];

  await t.test("a resolved command is ALWAYS one of the offered candidates", () => {
    for (const set of sets) {
      for (const reply of replies) {
        const r = resolveClarification({ reply, candidates: set.candidates, profile: set.profile });
        if (r.status === "resolved") {
          assert.ok(
            set.candidates.includes(r.commandId),
            `${reply} → ${r.commandId} is outside the offered set ${set.candidates.join(",")}`,
          );
        }
      }
    }
  });

  await t.test("the resolver never emits a status other than the three contract states", () => {
    for (const set of sets) {
      for (const reply of replies) {
        const r = resolveClarification({ reply, candidates: set.candidates, profile: set.profile });
        assert.ok(
          r.status === "resolved" || r.status === "cancelled" || r.status === "unresolved",
          `unexpected status ${r.status}`,
        );
      }
    }
  });

  await t.test("a resolved guarded command always requires confirmation", () => {
    // WINCH candidates are both actuate/critical → every resolution is guarded.
    for (const reply of ["the first one", "the down one", "winch up"]) {
      const r = resolveClarification({ reply, candidates: WINCH, profile: "trailer" });
      if (r.status === "resolved") assert.equal(r.requiresConfirmation, true, reply);
    }
    // send-quote is propose/critical → guarded; draft-quote is propose/routine → not.
    const send = resolveClarification({ reply: "send it", candidates: QUOTES, profile: "client" });
    assert.equal(send.status === "resolved" && send.requiresConfirmation, true);
    const draft = resolveClarification({
      reply: "draft one",
      candidates: QUOTES,
      profile: "client",
    });
    assert.equal(draft.status === "resolved" && draft.requiresConfirmation, false);
  });

  await t.test("no resolution path exposes an approval or authority field", () => {
    const r = resolveClarification({
      reply: "the first one",
      candidates: WINCH,
      profile: "trailer",
    });
    assert.ok(!("approval" in r) && !("authority" in r) && !("approved" in r));
  });
});
