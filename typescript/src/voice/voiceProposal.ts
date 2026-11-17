/**
 * NOLAN voice — turning a model's structured proposal into a command sentence.
 *
 * With conversation enabled, Claude understands free speech ("chuck bar oil on
 * the shopping list") and may propose exactly one change through the
 * `propose_change` tool. It never stages anything itself. This module turns the
 * proposal into a canonical sentence in NOLAN's existing dictation grammar
 * ("add an errand: Bar oil"), which the session then handles exactly like
 * spoken dictation: every guard, record lookup and the full read-back apply,
 * and nothing is staged until the owner says "Nolan confirm".
 *
 * The sentence is built here, deterministically, from validated fields. Model
 * text is only ever a field value that the grammar re-checks.
 */

import { z } from "zod";

import { VOICE_TASK_CATEGORIES } from "./voiceDictation.js";
import { parseSpokenDuePhrase, type SpokenDueContext } from "./voiceReminderDue.js";

const text = z.string().trim().min(1).max(200);

export const VOICE_PROPOSAL_ACTIONS = [
  "add_task",
  "add_reminder",
  "add_errand",
  "complete",
  "cancel_reminder",
  "remove_errand",
  "reschedule_reminder",
] as const;

export const voiceProposalSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("add_task"),
      title: text,
      category: z.enum(VOICE_TASK_CATEGORIES).optional(),
    })
    .strict(),
  z.object({ action: z.literal("add_reminder"), title: text, due: text.optional() }).strict(),
  z.object({ action: z.literal("add_errand"), title: text }).strict(),
  z
    .object({
      action: z.literal("complete"),
      reference: text,
      kind: z.enum(["task", "errand"]).optional(),
    })
    .strict(),
  z.object({ action: z.literal("cancel_reminder"), reference: text }).strict(),
  z.object({ action: z.literal("remove_errand"), reference: text }).strict(),
  z.object({ action: z.literal("reschedule_reminder"), reference: text, due: text }).strict(),
]);

export type VoiceProposal = z.infer<typeof voiceProposalSchema>;

/** JSON schema for the `propose_change` tool. Validation happens in voiceProposalSchema. */
export const PROPOSE_CHANGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...VOICE_PROPOSAL_ACTIONS] },
    title: {
      type: "string",
      description:
        "add_task / add_reminder / add_errand: a short to-do in Benny's words, starting with the " +
        'action or the item ("Ring the council", "Bar oil"), never with I, we or need to.',
    },
    category: {
      type: "string",
      enum: [...VOICE_TASK_CATEGORIES],
      description: "add_task only, and only if Benny named one.",
    },
    reference: {
      type: "string",
      description:
        "complete / cancel_reminder / remove_errand / reschedule_reminder: one to three distinctive " +
        'words as they appear in the existing item\'s title, verbs in base form ("Dave", "bar oil").',
    },
    kind: {
      type: "string",
      enum: ["task", "errand"],
      description: "complete only, and only if Benny said task or errand.",
    },
    due: {
      type: "string",
      description:
        "add_reminder (optional) / reschedule_reminder (required): a due phrase in this exact form: " +
        '"today", "tomorrow", "tonight", or a weekday like "friday", optionally followed by ' +
        '"at" and a time like "9 am", "3:30 pm" or "noon"; or just "at 3 pm". ' +
        'Never "next friday", dates, or relative durations.',
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

/** One-line tool description shown to the model. */
export const PROPOSE_CHANGE_DESCRIPTION =
  "Propose exactly one change to Benny's tasks, reminders or errands. NOLAN reads it back and " +
  'nothing happens unless Benny says "Nolan confirm" and then approves it. Use it only when ' +
  "Benny asks for a change. Never combine it with a query in the same turn.";

/**
 * The canonical dictation sentence for a proposal, or undefined when the
 * proposal cannot be expressed safely (for example a due phrase outside the
 * bounded grammar, which would otherwise end up inside the title).
 */
export function proposalUtterance(
  proposal: VoiceProposal,
  due: SpokenDueContext,
): string | undefined {
  switch (proposal.action) {
    case "add_task":
      return `add a ${proposal.category ? `${proposal.category} ` : ""}task: ${proposal.title}`;
    case "add_reminder": {
      if (proposal.due === undefined) return `remind me to ${proposal.title}`;
      const parsed = parseSpokenDuePhrase(proposal.due.toLowerCase(), due);
      if (parsed === "none" || parsed === "rejected") return undefined;
      return `remind me to ${proposal.title} ${proposal.due.toLowerCase()}`;
    }
    case "add_errand":
      return `add an errand: ${proposal.title}`;
    case "complete":
      return `tick off ${proposal.kind ? `the ${proposal.kind} ` : ""}${proposal.reference}`;
    case "cancel_reminder":
      return `cancel the reminder: ${proposal.reference}`;
    case "remove_errand":
      return `remove the errand: ${proposal.reference}`;
    case "reschedule_reminder":
      return `move the reminder called ${proposal.reference} to ${proposal.due.toLowerCase()}`;
  }
}
