/**
 * NOLAN voice — small talk ("thanks mate", "g'day").
 *
 * Matched only against fixed whole phrases, answered with a fixed reply, and
 * never handed to the conversation model: it reads nothing and does nothing.
 */

import { rundownMatchKey } from "./voiceRundown.js";

const THANKS = new Set([
  "thanks",
  "thank you",
  "thanks mate",
  "thank you mate",
  "thanks nolan",
  "thank you nolan",
  "cheers",
  "cheers mate",
  "ta",
  "ta mate",
  "legend",
  "good on ya",
  "good stuff",
  "nice one",
  "perfect",
  "awesome",
  "beauty",
  "sweet",
]);

const GREETINGS = new Set([
  "hi",
  "hey",
  "hello",
  "gday",
  "gday mate",
  "hey mate",
  "hi mate",
  "hello mate",
  "morning",
  "good morning",
  "afternoon",
  "good afternoon",
  "evening",
  "good evening",
  "you there",
  "are you there",
  "hows it going",
  "how are you",
  "how ya going",
  "how are ya",
]);

const GOODBYES = new Set([
  "thats all",
  "thats it",
  "thats all thanks",
  "thats it thanks",
  "all good",
  "all good thanks",
  "no thats all",
  "nah thats it",
  "bye",
  "see ya",
  "later",
  "catch ya",
  "night",
  "good night",
]);

/** A fixed friendly reply for a whole small-talk phrase, else undefined. */
export function smallTalkReply(transcript: string): string | undefined {
  const key = rundownMatchKey(transcript.replace(/\bnolan\b[,!.]?\s*$/i, "").trim());
  if (THANKS.has(key)) return "No worries.";
  if (GREETINGS.has(key)) return "G'day. What can I do for you?";
  if (GOODBYES.has(key)) return "No worries. Catch you later.";
  return undefined;
}
