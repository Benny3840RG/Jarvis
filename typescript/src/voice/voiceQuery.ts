/**
 * Jarvis guarded voice interface — read-only query boundary (#567, Stage 3).
 *
 * The voice session never reads business or equipment state directly; it asks a
 * `VoiceQueryProvider`. A `query` command is information-only: it can never
 * actuate equipment, stage or approve a governed action, or hold a credential.
 *
 * No query provider ships wired by default, so the provider here is
 * {@link DisconnectedQueryProvider}, which reports every query unavailable and
 * NEVER fabricates an answer. That preserves the pre-Stage-3 behaviour exactly
 * ("recognising a command is not a successful answer") and fails closed.
 *
 * A real provider, when connected, implements this same interface and is the
 * only thing permitted to return `status: "answered"`. It must be deterministic
 * and backed by Jarvis's existing authoritative read models — never an LLM
 * interpreting raw storage.
 */

import type { VoiceProfile } from "./voiceCommands.js";

export type VoiceQueryRequest = Readonly<{
  /** The recognised query command's stable id (`<profile>.<name>`). */
  commandId: string;
  /** The session profile the command was recognised under. */
  profile: VoiceProfile;
}>;

export type VoiceQueryResult =
  /** The provider answered from an authoritative read model. */
  | Readonly<{ status: "answered"; commandId: string; answer: string }>
  /** No read model can answer this query right now; nothing was read. */
  | Readonly<{ status: "unavailable"; commandId: string; reason: string }>
  /** The provider attempted the read and it failed; treat as fail-closed. */
  | Readonly<{ status: "failed"; commandId: string; reason: string }>;

export interface VoiceQueryProvider {
  /**
   * Answer a read-only query. Must never fabricate an answer when the backing
   * read model is absent or errors: report `unavailable` or `failed` instead.
   */
  answer(request: VoiceQueryRequest): Promise<VoiceQueryResult>;
}

/** The reason surfaced when no read-only query provider is connected. */
export const NO_QUERY_PROVIDER_REASON =
  "No read-only query provider is connected for this voice command.";

/**
 * The provider wired by default: no read model is connected, so every query is
 * unavailable and nothing is ever answered.
 */
export class DisconnectedQueryProvider implements VoiceQueryProvider {
  async answer(request: VoiceQueryRequest): Promise<VoiceQueryResult> {
    return {
      status: "unavailable",
      commandId: request.commandId,
      reason: NO_QUERY_PROVIDER_REASON,
    };
  }
}
