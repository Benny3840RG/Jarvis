import type { Intent } from "./conversationService.js";

/**
 * Single source of truth for mapping free text to a Jarvis {@link Intent}.
 *
 * Both `ConversationService.parse` and `IntentRouter.route` previously classified
 * intent with their own `String.includes` checks, which disagreed with each other
 * and matched short tokens inside unrelated words — "this plan" contains "hi", so
 * it was misread as a greeting. This classifier replaces that with ordered,
 * word-boundary rules so a keyword only counts as a whole word.
 *
 * Rules are evaluated in precedence order; the first matching intent wins.
 */
type IntentRule = { intent: Intent; patterns: RegExp[] };

const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: "greeting",
    patterns: [/\b(hello|hi|hey|greetings|howdy)\b/, /\bgood (morning|afternoon|evening)\b/],
  },
  {
    intent: "planning",
    patterns: [
      /\b(plan|planning|plans|schedule|scheduling|task|tasks|organise|organize|prepare|todo)\b/,
      /\b(kick off|set up|line up|sort out|to-do)\b/,
    ],
  },
  {
    intent: "memory",
    patterns: [/\b(remember|recall|memorise|memorize|forget)\b/, /\bmy name\b/, /\bnote that\b/],
  },
];

export function classifyIntent(text: string): Intent {
  const lower = text.toLowerCase();
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(lower))) return rule.intent;
  }
  return "general";
}
