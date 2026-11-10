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
    const r = resolveClarification({
      reply: "send it",
      candidates: ["client.send-quote"],
      profile: "trailer",
    });
    assert.deepEqual(r.status === "unresolved" && r.candidates, []);
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

  await t.test("a negated distinctive token is never resolved (jarvis-pr-maintenance #790)", () => {
    // "do not send it" contains the distinctive token "send"; the negation must
    // be seen first so send-quote is never passed to downstream confirmation.
    for (const reply of ["do not send it", "don't send it", "never send it"]) {
      const r = resolveClarification({ reply, candidates: QUOTES, profile: "client" });
      assert.notEqual(r.status, "resolved", reply);
    }
  });

  await t.test("a negated ordinal is never resolved", () => {
    const r = resolveClarification({
      reply: "not the first one",
      candidates: WINCH,
      profile: "trailer",
    });
    assert.notEqual(r.status, "resolved");
  });

  await t.test("a hard negation with no selection cancels", () => {
    assert.equal(
      resolveClarification({ reply: "don't bother", candidates: WINCH, profile: "trailer" }).status,
      "cancelled",
    );
  });

  await t.test("a hard negation voids a co-occurring positive selection", () => {
    // "not the draft, send it" names BOTH candidates and carries a hard
    // negation. Even with a clear positive token ("send"), the negation must be
    // honoured first so a guarded send-quote is never leaked to downstream
    // confirmation. Fail-closed over any clever disambiguation (#790).
    const r = resolveClarification({
      reply: "not the draft, send it",
      candidates: QUOTES,
      profile: "client",
    });
    assert.equal(r.status, "unresolved");
  });

  await t.test("an explicit refusal never resolves the candidate it names (Codex #790)", () => {
    for (const reply of [
      "cancel send it",
      "neither send it",
      "anything but send it",
      "forget the second one",
      "cancel the first",
      "the other one, not send",
      "scrap that, send it",
      "no send it",
      "no, send it",
      "nope send it",
      "send it, cancel",
      "rather than send it",
      "instead of send it",
      "all except send it",
      "no the last",
    ]) {
      const r = resolveClarification({ reply, candidates: QUOTES, profile: "client" });
      assert.equal(r.status, "unresolved", reply);
    }
  });

  await t.test("the safety-critical stop command stays selectable", () => {
    const r = resolveClarification({
      reply: "stop",
      candidates: ["crawler.stop", "crawler.record-start"],
      profile: "crawler",
    });
    assert.equal(r.status === "resolved" && r.commandId, "crawler.stop");
  });

  await t.test("a soft decline after the selection retracts it", () => {
    for (const reply of ["send it, nah", "the first one naw"]) {
      const r = resolveClarification({ reply, candidates: QUOTES, profile: "client" });
      assert.equal(r.status, "unresolved", reply);
    }
  });

  await t.test("split and curly-apostrophe contractions are hard negations (Codex #790)", () => {
    for (const reply of [
      "do n't send it",
      "do n\u2019t send it",
      "don\u2019t send it",
      "don t send it",
      "do n t send it",
      "do nt send it",
      "won 't send it",
    ]) {
      const r = resolveClarification({ reply, candidates: QUOTES, profile: "client" });
      assert.equal(r.status, "unresolved", reply);
    }
  });

  await t.test("a mixed or invalid offered set fails closed, positions never shift", () => {
    // Offered second; filtering must not make it "first" (Codex #790).
    const mixed = resolveClarification({
      reply: "first",
      candidates: ["client.send-quote", "trailer.winch-up"],
      profile: "trailer",
    });
    assert.equal(mixed.status, "unresolved");
    // The open clarification carries only live candidates (jarvis-pr-maintenance).
    assert.deepEqual(mixed.status === "unresolved" && mixed.candidates, ["trailer.winch-up"]);

    for (const candidates of [
      ["no.such-command", "trailer.winch-up"],
      ["trailer.winch-up", "trailer.winch-up"],
      ["trailer.winch-up", "no.such-command"],
    ]) {
      for (const reply of ["first", "the last one", "winch up", "yes"]) {
        const r = resolveClarification({ reply, candidates, profile: "trailer" });
        assert.equal(r.status, "unresolved", `${reply} / ${candidates.join(",")}`);
        assert.deepEqual(r.status === "unresolved" && r.candidates, ["trailer.winch-up"]);
      }
    }
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
    "do not send it",
    "don't send it",
    "not the first one",
    "never that one",
    "not the draft, send it",
    "cancel send it",
    "neither send it",
    "anything but send it",
    "do n't send it",
    "don t send it",
    "send it no",
    "no send it",
    "rather than send it",
    "the other one",
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
