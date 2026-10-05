/**
 * Jarvis guarded voice interface — the strict utterance parser (#567).
 *
 * Pure and deterministic. Two safety rules live here and are tested in
 * `tests/voiceParser.test.ts`:
 *
 *   1. Final-only dispatch. An interim (non-final) transcript NEVER resolves to
 *      a command, even if it matches exactly. Partial speech cannot actuate.
 *   2. Whole-utterance exact match. After normalisation the transcript must
 *      equal a command phrase in full — never a substring — so a longer
 *      sentence can never smuggle a command through.
 *
 * Recogniser alternatives only ever REDUCE confidence: when the top hypothesis
 * matches one command but an alternative matches a different one, the result is
 * `ambiguous` (rejected, fail closed). A lower-confidence alternative is never
 * promoted to a match when the top hypothesis does not itself match.
 */

import {
  findVoiceCommand,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";

export type ParseInput = Readonly<{
  transcript: string;
  isFinal: boolean;
  profile: VoiceProfile;
  /** Lower-confidence alternative hypotheses from the recogniser, if any. */
  alternatives?: readonly string[];
}>;

export type VoiceRecognitionOutcome =
  /** Interim transcript — withheld from dispatch until a final transcript arrives. */
  | Readonly<{ status: "pending-final"; normalizedTranscript: string }>
  /** Final transcript that normalised to nothing. */
  | Readonly<{ status: "empty" }>
  /** Final transcript that matched no command in the active profile. */
  | Readonly<{ status: "no-match"; normalizedTranscript: string }>
  /** Conflicting recogniser hypotheses — rejected rather than guessed. */
  | Readonly<{ status: "ambiguous"; normalizedTranscript: string; candidates: readonly string[] }>
  /** Exactly one command, unambiguously resolved. */
  | Readonly<{ status: "recognized"; command: VoiceCommand; normalizedTranscript: string }>;

export function parseUtterance(input: ParseInput): VoiceRecognitionOutcome {
  const normalizedTranscript = normalizeUtterance(input.transcript);

  // Rule 1: final-only dispatch. Nothing an interim transcript says can act.
  if (!input.isFinal) {
    return { status: "pending-final", normalizedTranscript };
  }

  if (normalizedTranscript === "") {
    return { status: "empty" };
  }

  // Rule 2: the top hypothesis must itself match a whole command phrase. A
  // lower-confidence alternative is never promoted on its own.
  const top = findVoiceCommand(input.profile, normalizedTranscript);
  if (!top) {
    return { status: "no-match", normalizedTranscript };
  }

  // Alternatives can only cast doubt: if any resolves to a different command,
  // fail closed as ambiguous.
  const matched = new Set<string>([top.id]);
  for (const alternative of input.alternatives ?? []) {
    const command = findVoiceCommand(input.profile, normalizeUtterance(alternative));
    if (command) matched.add(command.id);
  }
  if (matched.size > 1) {
    return {
      status: "ambiguous",
      normalizedTranscript,
      candidates: Object.freeze([...matched].sort()),
    };
  }

  return { status: "recognized", command: top, normalizedTranscript };
}
