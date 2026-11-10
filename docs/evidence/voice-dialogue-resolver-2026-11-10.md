# Voice clarification resolver — evidence (Wave Two, #567)

**Date:** 2026-11-10
**Status:** advisory, **not wired** into any live path. Evaluation + module only; no
production behaviour changed, nothing commissioned.
**Reproduce:**
`cd typescript && node --import tsx --test tests/voiceDialogueResolver.test.ts`
(22/22) — also runs inside `npm run test:node` / `npm run check`.

## What this adds

The Wave One interpreter (`voiceIntentInterpreter.ts`) turns a single transcript
into a proposal, a `needs-clarification` with a candidate set, or `no-intent`.
It has no second turn: when it asks "winch up or winch down?", nothing resolves
the reply. `voiceDialogueResolver.ts` closes that turn.

`resolveClarification({ reply, candidates, profile, isFinal? })` →

| status | meaning |
|---|---|
| `resolved` | the reply named exactly one offered candidate (+ `confidence`, `requiresConfirmation`) |
| `cancelled` | the reply declined every candidate |
| `unresolved` | still no single choice — the clarification stays open |

## Safety contract (the reason it is safe to add before wiring)

1. **Confined to the offered set.** Resolution is computed only over the
   candidate ids the interpreter already proposed, after dropping any id not in
   the active profile. There is no code path by which a follow-up can name a
   command the prior turn did not — proven by the invariant test *"a resolved
   command is ALWAYS one of the offered candidates"* over 18 replies × 4 sets.
2. **Fails closed.** A shared token, a two-candidate reply, a bare "yes" to
   several options, an out-of-range ordinal, an interim reply, an empty set, or
   an unrelated utterance all leave the clarification `unresolved` — never a
   guess.
3. **Never upgrades authority.** A resolved guarded command (`actuate` or
   `critical`) still carries `requiresConfirmation: true`; no resolution path
   exposes an approval/authority field. The resolver dispatches nothing — a
   resolved command is advisory context for the existing spoken-confirmation
   boundary.
4. **Not wired.** Like the interpreter's first increment, it sits in no live
   path (`voiceParser.ts` / `voiceSession.ts` unchanged). Wiring it is a
   separate, owner-gated production change.

## Verified behaviour (from the test matrix)

| Reply | Candidates | Result |
|---|---|---|
| "the first one" | winch-up, winch-down | → winch-up |
| "second please" | winch-up, winch-down | → winch-down |
| "the last one" | winch-up, winch-down | → winch-down |
| "the down one" | winch-up, winch-down | → winch-down |
| "send it" | draft-quote, send-quote | → send-quote (requiresConfirmation) |
| "nah the winch up one" | winch-up, lights-on | → winch-up (selection beats filler "nah") |
| "yeah that's it" | send-quote | → send-quote (single-candidate affirmation) |
| "nah forget it" | winch-up, winch-down | cancelled |
| "neither of those" | draft-quote, send-quote | cancelled |

## Verified fail-closed cases

| Reply | Candidates | Result | Why |
|---|---|---|---|
| "the winch one" | winch-up, winch-down | unresolved | "winch" shared → distinctive of neither |
| "winch up or lights" | winch-up, lights-on | unresolved | names two candidates |
| "yes" | winch-up, winch-down | unresolved | bare affirmation, several options |
| "the third one" | winch-up, winch-down | unresolved | ordinal out of range |
| "the first one" (`isFinal:false`) | winch-up, winch-down | unresolved | interim reply |
| "send it" | client.send-quote (under `trailer`) | unresolved | candidate not in active profile |
| "what is the weather" | winch-up, winch-down | unresolved | no selection, no decline |
| "no" | winch-up, winch-down | cancelled | pure negation, never resolves |
| "do not send it" | draft-quote, send-quote | unresolved | hard negation scopes the "send" token — never resolves send-quote |
| "not the draft, send it" | draft-quote, send-quote | unresolved | hard negation voids a co-occurring positive selection |
| "don't bother" | winch-up, winch-down | cancelled | hard negation, no selection |

> **Hard vs soft negation.** A hard scoping negation (`not`, `don't`, `never`,
> `can't`, …) is checked *before* any positive selection, so a distinctive token
> inside a refusal ("send" in "do not send it") can never resolve — it fails
> closed to `unresolved` (negated selection) or `cancelled` (no selection). Soft
> interjections ("nah", "no") are not hard negations, so an explicit selection
> still overrides them ("nah, the winch up one" → winch-up). The tokeniser
> strips apostrophes and splits on non-alphanumerics, matching the interpreter,
> so contractions like "don't" are recognised. (Closes jarvis-pr-maintenance
> finding on #790.)

## Next (identified, not started)

Wiring the resolver behind the confirmation path — when a session is in a
pending `needs-clarification` state, route the next final utterance through
`resolveClarification` before re-interpreting — is a production-behaviour change
= a new owner-assigned mission. Not started while this and #786 are draft.
