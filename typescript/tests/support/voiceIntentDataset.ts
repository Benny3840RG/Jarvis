/**
 * Voice-intent evaluation dataset (#567 — Wave One preparation).
 *
 * PURPOSE. This is an *evaluation* fixture, not production behaviour. It
 * measures the gap between how a person actually speaks and the strict,
 * whole-utterance phrases the guarded parser (`src/voice/voiceParser.ts`)
 * accepts today. The parser is deliberately exact-match and fail-closed; its
 * rejections of near-miss phrasing are correct *safety* behaviour, not bugs.
 * What this dataset quantifies is the *coverage* a future natural-language
 * layer would have to close — ahead of the deterministic action boundary,
 * never through it.
 *
 * LABELLING CONTRACT.
 *   - `expectedCommandId` names the single catalog command a competent human
 *     clearly intends by the utterance, OR `null` when no single command is
 *     intended (genuinely ambiguous speech, or an adversarial/safety probe).
 *   - A case is only labelled with a non-null intent when a reasonable operator
 *     would agree there is exactly one right answer. Ambiguity is labelled
 *     `null` on purpose, so "correctly withheld" is scored as success, not as a
 *     coverage miss.
 *   - `heldOut` marks natural cases reserved from any future tuning set, so a
 *     later NLU layer cannot be scored against data it was fitted on.
 *
 * All phrasings are this author's realistic Australian/informal renderings, not
 * a transcript of any real person. ASR-error cases are plausible
 * speech-recognition corruptions of a canonical phrase.
 */

import type { VoiceProfile } from "../../src/voice/voiceCommands.js";

export type IntentCategory =
  /** Exact catalog phrase. Sanity anchor: must be recognised. */
  | "canonical"
  /** Natural Australian/informal phrasing of one clear intent. */
  | "informal-au"
  /** Plausible speech-recognition corruption of a canonical phrase. */
  | "asr-error"
  /** Genuinely ambiguous: clarification is the correct response (expected null). */
  | "ambiguous-intent"
  /** A command phrase embedded in a longer sentence, often negated (expected null). */
  | "safety-substring"
  /** A valid phrase spoken under the wrong active profile (expected null). */
  | "safety-cross-profile"
  /** An exact phrase on an interim (non-final) transcript (expected null). */
  | "safety-interim"
  /** Top hypothesis and an alternative resolve to different commands (expected null). */
  | "safety-ambiguous";

export type EvalCase = Readonly<{
  id: string;
  profile: VoiceProfile;
  transcript: string;
  /** Defaults to true; set false only for `safety-interim`. */
  isFinal: boolean;
  /** Lower-confidence recogniser alternatives; only used by `safety-ambiguous`. */
  alternatives?: readonly string[];
  category: IntentCategory;
  /** The single clearly-intended command id, or null when none is intended. */
  expectedCommandId: string | null;
  /** Reserved from any future tuning set. */
  heldOut: boolean;
  note?: string;
}>;

type Opts = Readonly<{
  isFinal?: boolean;
  alternatives?: readonly string[];
  heldOut?: boolean;
  note?: string;
}>;

function makeCase(
  id: string,
  profile: VoiceProfile,
  transcript: string,
  category: IntentCategory,
  expectedCommandId: string | null,
  opts: Opts = {},
): EvalCase {
  return Object.freeze({
    id,
    profile,
    transcript,
    category,
    expectedCommandId,
    isFinal: opts.isFinal ?? true,
    heldOut: opts.heldOut ?? false,
    ...(opts.alternatives ? { alternatives: Object.freeze([...opts.alternatives]) } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
}

const canonical: readonly EvalCase[] = [
  // One anchor per command: exact phrase must resolve. Verifies the dataset's
  // labels agree with the live catalog.
  makeCase("can-crawler-status", "crawler", "Crawler status.", "canonical", "crawler.status"),
  makeCase("can-crawler-forward", "crawler", "crawler forward", "canonical", "crawler.forward"),
  makeCase("can-crawler-reverse", "crawler", "crawler reverse", "canonical", "crawler.reverse"),
  makeCase("can-crawler-stop", "crawler", "crawler stop", "canonical", "crawler.stop"),
  makeCase("can-crawler-halt", "crawler", "crawler halt", "canonical", "crawler.stop"),
  makeCase(
    "can-crawler-lights-on",
    "crawler",
    "crawler lights on",
    "canonical",
    "crawler.lights-on",
  ),
  makeCase(
    "can-crawler-lights-off",
    "crawler",
    "crawler lights off",
    "canonical",
    "crawler.lights-off",
  ),
  makeCase(
    "can-crawler-rec-start",
    "crawler",
    "start crawler recording",
    "canonical",
    "crawler.record-start",
  ),
  makeCase(
    "can-crawler-rec-stop",
    "crawler",
    "stop crawler recording",
    "canonical",
    "crawler.record-stop",
  ),
  makeCase("can-workshop-status", "workshop", "workshop status", "canonical", "workshop.status"),
  makeCase("can-workshop-next", "workshop", "next job", "canonical", "workshop.next-job"),
  makeCase(
    "can-workshop-next2",
    "workshop",
    "what is my next job",
    "canonical",
    "workshop.next-job",
  ),
  makeCase(
    "can-workshop-lights-on",
    "workshop",
    "workshop lights on",
    "canonical",
    "workshop.lights-on",
  ),
  makeCase(
    "can-workshop-lights-off",
    "workshop",
    "workshop lights off",
    "canonical",
    "workshop.lights-off",
  ),
  makeCase(
    "can-workshop-comp-on",
    "workshop",
    "start the compressor",
    "canonical",
    "workshop.compressor-on",
  ),
  makeCase(
    "can-workshop-comp-off",
    "workshop",
    "stop the compressor",
    "canonical",
    "workshop.compressor-off",
  ),
  makeCase("can-workshop-builds", "workshop", "workshop builds", "canonical", "workshop.builds"),
  makeCase("can-workshop-assets", "workshop", "workshop assets", "canonical", "workshop.assets"),
  makeCase(
    "can-workshop-maint",
    "workshop",
    "maintenance due",
    "canonical",
    "workshop.maintenance",
  ),
  makeCase(
    "can-workshop-note",
    "workshop",
    "log a workshop note",
    "canonical",
    "workshop.log-note",
  ),
  makeCase("can-trailer-status", "trailer", "trailer status", "canonical", "trailer.status"),
  makeCase(
    "can-trailer-lights-on",
    "trailer",
    "trailer lights on",
    "canonical",
    "trailer.lights-on",
  ),
  makeCase(
    "can-trailer-lights-off",
    "trailer",
    "trailer lights off",
    "canonical",
    "trailer.lights-off",
  ),
  makeCase("can-trailer-winch-up", "trailer", "winch up", "canonical", "trailer.winch-up"),
  makeCase("can-trailer-winch-down", "trailer", "winch down", "canonical", "trailer.winch-down"),
  makeCase(
    "can-trailer-ramp-deploy",
    "trailer",
    "deploy the ramp",
    "canonical",
    "trailer.ramp-deploy",
  ),
  makeCase("can-trailer-ramp-stow", "trailer", "stow the ramp", "canonical", "trailer.ramp-stow"),
  makeCase("can-client-today", "client", "what is on today", "canonical", "client.todays-schedule"),
  makeCase(
    "can-client-next-appt",
    "client",
    "when is my next appointment",
    "canonical",
    "client.next-appointment",
  ),
  makeCase("can-client-week", "client", "jobs this week", "canonical", "client.jobs-this-week"),
  makeCase(
    "can-client-unpaid",
    "client",
    "any unpaid invoices",
    "canonical",
    "client.unpaid-invoices",
  ),
  makeCase(
    "can-client-enquiries",
    "client",
    "any open enquiries",
    "canonical",
    "client.open-enquiries",
  ),
  makeCase(
    "can-client-quote-fu",
    "client",
    "quote follow-up",
    "canonical",
    "client.quote-follow-up",
  ),
  makeCase("can-client-tasks", "client", "open tasks", "canonical", "client.open-tasks"),
  makeCase("can-client-reminders", "client", "any reminders", "canonical", "client.reminders"),
  makeCase("can-client-errands", "client", "open errands", "canonical", "client.open-errands"),
  makeCase("can-client-draft", "client", "draft a quote", "canonical", "client.draft-quote"),
  makeCase("can-client-send", "client", "send the quote", "canonical", "client.send-quote"),
  makeCase(
    "can-client-fu-rem",
    "client",
    "remind me to follow up",
    "canonical",
    "client.follow-up-reminder",
  ),
  makeCase("can-client-task", "client", "add a task", "canonical", "client.capture-task"),
  makeCase("can-client-errand", "client", "add an errand", "canonical", "client.capture-errand"),
];

const informal: readonly EvalCase[] = [
  // ── Crawler ──
  makeCase(
    "inf-crawler-status-1",
    "crawler",
    "how's the crawler looking",
    "informal-au",
    "crawler.status",
  ),
  makeCase(
    "inf-crawler-status-2",
    "crawler",
    "give us a crawler status",
    "informal-au",
    "crawler.status",
    { heldOut: true },
  ),
  makeCase(
    "inf-crawler-fwd-1",
    "crawler",
    "send the crawler forward",
    "informal-au",
    "crawler.forward",
  ),
  makeCase(
    "inf-crawler-fwd-2",
    "crawler",
    "move the crawler ahead",
    "informal-au",
    "crawler.forward",
    { heldOut: true },
  ),
  makeCase("inf-crawler-rev-1", "crawler", "back the crawler up", "informal-au", "crawler.reverse"),
  makeCase("inf-crawler-rev-2", "crawler", "reverse the crawler", "informal-au", "crawler.reverse"),
  makeCase("inf-crawler-stop-1", "crawler", "stop the crawler", "informal-au", "crawler.stop"),
  makeCase("inf-crawler-stop-2", "crawler", "pull the crawler up", "informal-au", "crawler.stop", {
    heldOut: true,
  }),
  makeCase(
    "inf-crawler-lon-1",
    "crawler",
    "chuck the crawler lights on",
    "informal-au",
    "crawler.lights-on",
  ),
  makeCase(
    "inf-crawler-lon-2",
    "crawler",
    "turn the crawler lights on",
    "informal-au",
    "crawler.lights-on",
  ),
  makeCase(
    "inf-crawler-loff-1",
    "crawler",
    "kill the crawler lights",
    "informal-au",
    "crawler.lights-off",
    { heldOut: true },
  ),
  makeCase(
    "inf-crawler-rec-1",
    "crawler",
    "start recording on the crawler",
    "informal-au",
    "crawler.record-start",
  ),
  makeCase(
    "inf-crawler-rec-2",
    "crawler",
    "begin crawler recording",
    "informal-au",
    "crawler.record-start",
  ),
  makeCase(
    "inf-crawler-recstop-1",
    "crawler",
    "stop recording the crawler",
    "informal-au",
    "crawler.record-stop",
  ),
  // ── Workshop ──
  makeCase("inf-ws-status-1", "workshop", "how's the workshop", "informal-au", "workshop.status"),
  makeCase("inf-ws-next-1", "workshop", "what's my next job", "informal-au", "workshop.next-job"),
  makeCase(
    "inf-ws-next-2",
    "workshop",
    "what have I got next",
    "informal-au",
    "workshop.next-job",
    { heldOut: true },
  ),
  makeCase(
    "inf-ws-lon-1",
    "workshop",
    "chuck the lights on in the workshop",
    "informal-au",
    "workshop.lights-on",
  ),
  makeCase(
    "inf-ws-loff-1",
    "workshop",
    "turn the workshop lights off",
    "informal-au",
    "workshop.lights-off",
  ),
  makeCase(
    "inf-ws-comp-on-1",
    "workshop",
    "fire up the compressor",
    "informal-au",
    "workshop.compressor-on",
  ),
  makeCase(
    "inf-ws-comp-on-2",
    "workshop",
    "kick the compressor on",
    "informal-au",
    "workshop.compressor-on",
    { heldOut: true },
  ),
  makeCase(
    "inf-ws-comp-off-1",
    "workshop",
    "kill the compressor",
    "informal-au",
    "workshop.compressor-off",
  ),
  makeCase(
    "inf-ws-comp-off-2",
    "workshop",
    "shut the compressor down",
    "informal-au",
    "workshop.compressor-off",
  ),
  makeCase(
    "inf-ws-builds-1",
    "workshop",
    "show me the workshop builds",
    "informal-au",
    "workshop.builds",
  ),
  makeCase(
    "inf-ws-assets-1",
    "workshop",
    "what assets have we got",
    "informal-au",
    "workshop.assets",
    { heldOut: true },
  ),
  makeCase(
    "inf-ws-maint-1",
    "workshop",
    "what maintenance is due",
    "informal-au",
    "workshop.maintenance",
  ),
  makeCase(
    "inf-ws-maint-2",
    "workshop",
    "anything due for a service",
    "informal-au",
    "workshop.maintenance",
    { heldOut: true },
  ),
  makeCase(
    "inf-ws-note-1",
    "workshop",
    "jot down a workshop note",
    "informal-au",
    "workshop.log-note",
  ),
  // ── Trailer ──
  makeCase(
    "inf-tr-status-1",
    "trailer",
    "how's the trailer going",
    "informal-au",
    "trailer.status",
  ),
  makeCase(
    "inf-tr-lon-1",
    "trailer",
    "turn the trailer work lights on",
    "informal-au",
    "trailer.lights-on",
  ),
  makeCase("inf-tr-winch-up-1", "trailer", "raise the winch", "informal-au", "trailer.winch-up"),
  makeCase(
    "inf-tr-winch-up-2",
    "trailer",
    "bring the winch up",
    "informal-au",
    "trailer.winch-up",
    { heldOut: true },
  ),
  makeCase("inf-tr-winch-dn-1", "trailer", "lower the winch", "informal-au", "trailer.winch-down"),
  makeCase(
    "inf-tr-winch-dn-2",
    "trailer",
    "let the winch down",
    "informal-au",
    "trailer.winch-down",
  ),
  makeCase(
    "inf-tr-ramp-dep-1",
    "trailer",
    "put the ramp down",
    "informal-au",
    "trailer.ramp-deploy",
  ),
  makeCase("inf-tr-ramp-dep-2", "trailer", "drop the ramp", "informal-au", "trailer.ramp-deploy", {
    heldOut: true,
  }),
  makeCase(
    "inf-tr-ramp-stow-1",
    "trailer",
    "pack the ramp away",
    "informal-au",
    "trailer.ramp-stow",
  ),
  makeCase(
    "inf-tr-ramp-stow-2",
    "trailer",
    "put the ramp away",
    "informal-au",
    "trailer.ramp-stow",
  ),
  // ── Client ──
  makeCase(
    "inf-cl-today-1",
    "client",
    "what have I got on today",
    "informal-au",
    "client.todays-schedule",
  ),
  makeCase("inf-cl-today-2", "client", "what's on today", "informal-au", "client.todays-schedule"),
  makeCase(
    "inf-cl-appt-1",
    "client",
    "when's my next appointment",
    "informal-au",
    "client.next-appointment",
  ),
  makeCase(
    "inf-cl-week-1",
    "client",
    "what's on this week",
    "informal-au",
    "client.jobs-this-week",
  ),
  makeCase(
    "inf-cl-week-2",
    "client",
    "what jobs have I got this week",
    "informal-au",
    "client.jobs-this-week",
    { heldOut: true },
  ),
  makeCase(
    "inf-cl-unpaid-1",
    "client",
    "any outstanding invoices",
    "informal-au",
    "client.unpaid-invoices",
  ),
  makeCase(
    "inf-cl-unpaid-2",
    "client",
    "who hasn't paid",
    "informal-au",
    "client.unpaid-invoices",
    { heldOut: true },
  ),
  makeCase("inf-cl-enq-1", "client", "any new enquiries", "informal-au", "client.open-enquiries"),
  makeCase(
    "inf-cl-quote-fu-1",
    "client",
    "any quotes to chase",
    "informal-au",
    "client.quote-follow-up",
  ),
  makeCase(
    "inf-cl-tasks-1",
    "client",
    "what's on my task list",
    "informal-au",
    "client.open-tasks",
  ),
  makeCase("inf-cl-rem-1", "client", "have I got any reminders", "informal-au", "client.reminders"),
  makeCase(
    "inf-cl-errands-1",
    "client",
    "any errands to run",
    "informal-au",
    "client.open-errands",
    { heldOut: true },
  ),
  makeCase("inf-cl-draft-1", "client", "whip up a quote", "informal-au", "client.draft-quote"),
  makeCase("inf-cl-draft-2", "client", "draw up a quote", "informal-au", "client.draft-quote", {
    heldOut: true,
  }),
  makeCase("inf-cl-send-1", "client", "fire off the quote", "informal-au", "client.send-quote"),
  makeCase("inf-cl-send-2", "client", "shoot that quote out", "informal-au", "client.send-quote", {
    heldOut: true,
  }),
  makeCase(
    "inf-cl-furem-1",
    "client",
    "remind me to chase this up",
    "informal-au",
    "client.follow-up-reminder",
  ),
  makeCase(
    "inf-cl-task-1",
    "client",
    "chuck this on my task list",
    "informal-au",
    "client.capture-task",
  ),
  makeCase("inf-cl-errand-1", "client", "put an errand on", "informal-au", "client.capture-errand"),
];

const asrError: readonly EvalCase[] = [
  makeCase("asr-crawler-status", "crawler", "crawler statue", "asr-error", "crawler.status"),
  makeCase("asr-crawler-fwd", "crawler", "crawler for word", "asr-error", "crawler.forward"),
  makeCase("asr-crawler-stop", "crawler", "crawler stopp", "asr-error", "crawler.stop", {
    heldOut: true,
  }),
  makeCase("asr-crawler-lon", "crawler", "crawler light son", "asr-error", "crawler.lights-on"),
  makeCase("asr-ws-comp", "workshop", "start the compressa", "asr-error", "workshop.compressor-on"),
  makeCase("asr-ws-next", "workshop", "what is my next drop", "asr-error", "workshop.next-job", {
    heldOut: true,
  }),
  makeCase("asr-tr-winch-up-1", "trailer", "wench up", "asr-error", "trailer.winch-up"),
  makeCase("asr-tr-winch-up-2", "trailer", "winch app", "asr-error", "trailer.winch-up", {
    heldOut: true,
  }),
  makeCase("asr-tr-ramp", "trailer", "deploy the ram", "asr-error", "trailer.ramp-deploy"),
  makeCase(
    "asr-cl-today-apos",
    "client",
    "today's schedule",
    "asr-error",
    "client.todays-schedule",
    {
      note: "Catalog phrase is 'todays schedule' (no apostrophe); ASR emits the apostrophe.",
    },
  ),
  makeCase(
    "asr-cl-appt",
    "client",
    "when is my next appo",
    "asr-error",
    "client.next-appointment",
    { heldOut: true },
  ),
  makeCase("asr-cl-send", "client", "send the quota", "asr-error", "client.send-quote"),
];

const ambiguous: readonly EvalCase[] = [
  // No single command is intended; withholding (no-match) is the correct result.
  makeCase("amb-crawler-lights", "crawler", "lights", "ambiguous-intent", null, {
    note: "On or off? Clarification is correct.",
  }),
  makeCase("amb-ws-turn-off", "workshop", "turn it off", "ambiguous-intent", null, {
    note: "Lights or compressor? Clarification is correct.",
  }),
  makeCase("amb-cl-quote", "client", "sort the quote out", "ambiguous-intent", null, {
    note: "Draft or send? Clarification is correct.",
  }),
  makeCase("amb-cl-invoices", "client", "the invoices", "ambiguous-intent", null),
  makeCase("amb-tr-ramp", "trailer", "the ramp", "ambiguous-intent", null, {
    note: "Deploy or stow? Clarification is correct.",
  }),
];

const safety: readonly EvalCase[] = [
  // Interim transcripts: exact phrase, but non-final must never dispatch.
  makeCase("saf-int-crawler-stop", "crawler", "crawler stop", "safety-interim", null, {
    isFinal: false,
  }),
  makeCase("saf-int-winch-up", "trailer", "winch up", "safety-interim", null, { isFinal: false }),
  makeCase("saf-int-comp", "workshop", "start the compressor", "safety-interim", null, {
    isFinal: false,
  }),
  makeCase("saf-int-send", "client", "send the quote", "safety-interim", null, { isFinal: false }),
  // Substring smuggling: a command phrase embedded in a longer sentence, often
  // negated. Must not match (whole-utterance only).
  makeCase(
    "saf-sub-crawler-stop",
    "crawler",
    "please don't say crawler stop just yet",
    "safety-substring",
    null,
  ),
  makeCase("saf-sub-winch-up", "trailer", "do not winch up", "safety-substring", null),
  makeCase(
    "saf-sub-comp",
    "workshop",
    "whatever you do don't start the compressor",
    "safety-substring",
    null,
  ),
  makeCase("saf-sub-send", "client", "i don't want to send the quote", "safety-substring", null),
  makeCase(
    "saf-sub-ramp",
    "trailer",
    "we'll deploy the ramp later not now",
    "safety-substring",
    null,
  ),
  // Cross-profile: a valid phrase under the wrong active profile.
  makeCase("saf-xp-winch-crawler", "crawler", "winch up", "safety-cross-profile", null),
  makeCase("saf-xp-stop-workshop", "workshop", "crawler stop", "safety-cross-profile", null),
  makeCase("saf-xp-send-workshop", "workshop", "send the quote", "safety-cross-profile", null),
  makeCase("saf-xp-ramp-client", "client", "deploy the ramp", "safety-cross-profile", null),
  // Ambiguous recogniser hypotheses: top and alternative resolve to different
  // commands. Must fail closed as ambiguous.
  makeCase("saf-amb-winch", "trailer", "winch up", "safety-ambiguous", null, {
    alternatives: ["winch down"],
  }),
  makeCase("saf-amb-crawler", "crawler", "crawler stop", "safety-ambiguous", null, {
    alternatives: ["crawler forward"],
  }),
  makeCase("saf-amb-lights", "crawler", "crawler lights on", "safety-ambiguous", null, {
    alternatives: ["crawler lights off"],
  }),
];

export const VOICE_INTENT_DATASET: readonly EvalCase[] = Object.freeze([
  ...canonical,
  ...informal,
  ...asrError,
  ...ambiguous,
  ...safety,
]);

/** Dataset version, bumped whenever cases change so evidence stays traceable. */
export const VOICE_INTENT_DATASET_VERSION = "2026-11-10.1";
