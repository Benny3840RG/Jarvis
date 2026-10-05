/**
 * Jarvis guarded voice interface — the deterministic command catalog (#567).
 *
 * This module is the single source of truth for what the voice interface can
 * recognise. It is pure, side-effect free and exhaustively unit-tested
 * (`tests/voiceCommands.test.ts`). Nothing here actuates equipment, approves a
 * governed action or holds a credential: the catalog only *classifies* an
 * utterance so the parser and session can decide, safely, what to do with it.
 *
 * Safety contract carried from the issue #567 acceptance criteria:
 *   - commands match the WHOLE utterance exactly after normalisation, never a
 *     substring, so a long sentence can never smuggle a command in;
 *   - `actuate` commands name a hardware target and nothing else — with no
 *     hardware adapter present in main they resolve to "unavailable", never a
 *     simulated acknowledgement;
 *   - `propose` commands stage a governed ToolAction through the existing
 *     approval path — the voice layer never approves or executes;
 *   - `critical` commands always require a spoken confirmation step, which
 *     guards against accidental activation and is NOT an authorisation
 *     boundary (it never supplies JARVIS_APPROVAL_TOKEN).
 *
 * The specific phrasings below are this implementation of the recorded
 * requirements, not a verbatim reproduction of the original ChatGPT-session
 * spec (which is not in the repository and cannot be verified here). They are
 * deliberately conservative and unambiguous.
 */

export type VoiceProfile = "crawler" | "workshop" | "trailer" | "client";

export const VOICE_PROFILES: readonly VoiceProfile[] = ["crawler", "workshop", "trailer", "client"];

/**
 * What dispatching a recognised command does. None of these actuate or approve
 * on their own — each is a classification the session acts on under the
 * governed/hardware boundaries.
 */
export type VoiceDispatchKind =
  /** Read-only information request; safe to answer directly. */
  | "query"
  /** Stages a governed ToolAction. The voice layer never approves or executes. */
  | "propose"
  /** Physical/equipment actuation; requires a hardware adapter (absent in main). */
  | "actuate";

/** How costly a misfire is. `critical` commands fail closed on any doubt. */
export type VoiceCriticality = "routine" | "critical";

export type VoiceCommand = Readonly<{
  /** Stable, unique id (`<profile>.<name>`). */
  id: string;
  profile: VoiceProfile;
  /** Canonical whole-utterance phrases, already normalised. Match is exact. */
  phrases: readonly string[];
  kind: VoiceDispatchKind;
  criticality: VoiceCriticality;
  /**
   * When true, a spoken confirmation step is required before dispatch. This
   * guards against accidental interactive activation only; it is not an
   * authorisation boundary and never supplies an approval token.
   */
  requiresSpokenConfirmation: boolean;
  /** One-line human summary surfaced on the HUD. */
  summary: string;
  /** For `actuate`: the equipment target id consulted on the hardware provider. */
  actuationTarget?: string;
  /** For `propose`: the governed tool/operation this would stage (never run). */
  proposes?: Readonly<{ tool: string; operation: string }>;
}>;

/**
 * Session-level control phrases, handled by the session rather than the
 * catalog. Kept distinct from every command phrase (enforced by test) so a
 * confirmation can never be mistaken for a fresh command and vice versa.
 */
export const VOICE_CONTROL_PHRASES = {
  confirm: ["confirm", "confirm command", "yes confirm"],
  cancel: ["cancel", "cancel command", "belay that"],
} as const;

/**
 * Normalise an utterance for exact whole-utterance matching: lowercase, trim,
 * collapse internal whitespace, and strip surrounding punctuation that a
 * speech engine commonly appends (full stops, commas, question/exclamation
 * marks). Deterministic and idempotent. Internal apostrophes/hyphens are
 * preserved so "today's" stays distinct from "todays".
 */
export function normalizeUtterance(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:]+/, "")
    .replace(/[\s.,!?;:]+$/, "");
}

function command(entry: VoiceCommand): VoiceCommand {
  return Object.freeze({ ...entry, phrases: Object.freeze([...entry.phrases]) });
}

export const VOICE_COMMANDS: readonly VoiceCommand[] = Object.freeze([
  // ── Crawler: inspection crawler. Movement is critical and fails closed. ──
  command({
    id: "crawler.status",
    profile: "crawler",
    phrases: ["crawler status"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Report the crawler's reported availability and position.",
  }),
  command({
    id: "crawler.forward",
    profile: "crawler",
    phrases: ["crawler forward"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Drive the crawler forward.",
    actuationTarget: "crawler.drive",
  }),
  command({
    id: "crawler.reverse",
    profile: "crawler",
    phrases: ["crawler reverse"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Drive the crawler in reverse.",
    actuationTarget: "crawler.drive",
  }),
  command({
    id: "crawler.stop",
    profile: "crawler",
    phrases: ["crawler stop", "crawler halt"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Stop crawler movement.",
    actuationTarget: "crawler.drive",
  }),
  command({
    id: "crawler.lights-on",
    profile: "crawler",
    phrases: ["crawler lights on"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the crawler inspection lights on.",
    actuationTarget: "crawler.lights",
  }),
  command({
    id: "crawler.lights-off",
    profile: "crawler",
    phrases: ["crawler lights off"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the crawler inspection lights off.",
    actuationTarget: "crawler.lights",
  }),
  command({
    id: "crawler.record-start",
    profile: "crawler",
    phrases: ["start crawler recording"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Start recording the crawler camera feed.",
    actuationTarget: "crawler.recorder",
  }),
  command({
    id: "crawler.record-stop",
    profile: "crawler",
    phrases: ["stop crawler recording"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Stop recording the crawler camera feed.",
    actuationTarget: "crawler.recorder",
  }),

  // ── Workshop: fixed base. Powered plant is critical. ──
  command({
    id: "workshop.status",
    profile: "workshop",
    phrases: ["workshop status"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Report workshop equipment availability.",
  }),
  command({
    id: "workshop.next-job",
    profile: "workshop",
    phrases: ["what is my next job", "next job"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Read out the next scheduled job.",
  }),
  command({
    id: "workshop.lights-on",
    profile: "workshop",
    phrases: ["workshop lights on"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the workshop lights on.",
    actuationTarget: "workshop.lights",
  }),
  command({
    id: "workshop.lights-off",
    profile: "workshop",
    phrases: ["workshop lights off"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the workshop lights off.",
    actuationTarget: "workshop.lights",
  }),
  command({
    id: "workshop.compressor-on",
    profile: "workshop",
    phrases: ["start the compressor"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Start the workshop air compressor.",
    actuationTarget: "workshop.compressor",
  }),
  command({
    id: "workshop.compressor-off",
    profile: "workshop",
    phrases: ["stop the compressor"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Stop the workshop air compressor.",
    actuationTarget: "workshop.compressor",
  }),
  command({
    id: "workshop.log-note",
    profile: "workshop",
    phrases: ["log a workshop note"],
    kind: "propose",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Propose a workshop note for the operator to confirm.",
    proposes: { tool: "create_note", operation: "notes:create" },
  }),

  // ── Trailer: mobile rig. Mechanical motion is critical. ──
  command({
    id: "trailer.status",
    profile: "trailer",
    phrases: ["trailer status"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Report trailer equipment availability.",
  }),
  command({
    id: "trailer.lights-on",
    profile: "trailer",
    phrases: ["trailer lights on"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the trailer work lights on.",
    actuationTarget: "trailer.lights",
  }),
  command({
    id: "trailer.lights-off",
    profile: "trailer",
    phrases: ["trailer lights off"],
    kind: "actuate",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Turn the trailer work lights off.",
    actuationTarget: "trailer.lights",
  }),
  command({
    id: "trailer.winch-up",
    profile: "trailer",
    phrases: ["winch up"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Raise the trailer winch.",
    actuationTarget: "trailer.winch",
  }),
  command({
    id: "trailer.winch-down",
    profile: "trailer",
    phrases: ["winch down"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Lower the trailer winch.",
    actuationTarget: "trailer.winch",
  }),
  command({
    id: "trailer.ramp-deploy",
    profile: "trailer",
    phrases: ["deploy the ramp"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Deploy the trailer ramp.",
    actuationTarget: "trailer.ramp",
  }),
  command({
    id: "trailer.ramp-stow",
    profile: "trailer",
    phrases: ["stow the ramp"],
    kind: "actuate",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Stow the trailer ramp.",
    actuationTarget: "trailer.ramp",
  }),

  // ── Client: client-facing. Reads are direct; writes only propose. ──
  command({
    id: "client.todays-schedule",
    profile: "client",
    phrases: ["what is on today", "todays schedule"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Read out today's scheduled jobs.",
  }),
  command({
    id: "client.next-appointment",
    profile: "client",
    phrases: ["when is my next appointment"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Read out the next appointment.",
  }),
  command({
    id: "client.unpaid-invoices",
    profile: "client",
    phrases: ["any unpaid invoices"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Report the count of unpaid invoices.",
  }),
  command({
    id: "client.open-enquiries",
    profile: "client",
    phrases: ["any open enquiries"],
    kind: "query",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Report the count of open enquiries.",
  }),
  command({
    id: "client.draft-quote",
    profile: "client",
    phrases: ["draft a quote"],
    kind: "propose",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Propose a draft quote for the operator to review.",
    proposes: { tool: "quote_draft", operation: "quotes:draft" },
  }),
  command({
    id: "client.send-quote",
    profile: "client",
    phrases: ["send the quote"],
    kind: "propose",
    criticality: "critical",
    requiresSpokenConfirmation: true,
    summary: "Propose sending a quote. Approval stays on the governed owner path.",
    proposes: { tool: "quote_send", operation: "quotes:send" },
  }),
  command({
    id: "client.follow-up-reminder",
    profile: "client",
    phrases: ["remind me to follow up"],
    kind: "propose",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    summary: "Propose a follow-up reminder for the operator to confirm.",
    proposes: { tool: "create_reminder", operation: "reminders:create" },
  }),
]);

const COMMAND_INDEX: ReadonlyMap<string, VoiceCommand> = (() => {
  const index = new Map<string, VoiceCommand>();
  for (const entry of VOICE_COMMANDS) {
    for (const phrase of entry.phrases) index.set(`${entry.profile}\u0000${phrase}`, entry);
  }
  return index;
})();

/**
 * Resolve a command by profile and an already-normalised whole utterance.
 * Returns `undefined` when nothing matches exactly. Profile-scoped: a phrase
 * belonging to another profile does not resolve.
 */
export function findVoiceCommand(
  profile: VoiceProfile,
  normalizedUtterance: string,
): VoiceCommand | undefined {
  return COMMAND_INDEX.get(`${profile}\u0000${normalizedUtterance}`);
}
