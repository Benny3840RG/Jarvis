import { createAnthropicVoiceReasoner } from "./voiceAnthropicReasoner.js";
import { VoiceConversationService } from "./voiceConversation.js";

type Environment = Readonly<Record<string, string | undefined>>;

export type VoiceConversationStatus = Readonly<{
  status: "configured" | "not-configured";
  provider: "anthropic" | null;
  model: string | null;
  reason: string;
}>;

const DEFAULT_MODEL = "claude-opus-5-5";

function bound(env: Environment, name: string, fallback: number, max: number): number | null {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

/** Configuration observation only; no SDK construction and no live call. */
export function resolveVoiceConversationStatus(
  env: Environment = process.env,
): VoiceConversationStatus {
  const selected = env.JARVIS_VOICE_CONVERSATION_PROVIDER?.trim();
  if (!selected)
    return {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "Voice conversation is disabled.",
    };
  if (selected !== "anthropic")
    return {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "Unsupported JARVIS_VOICE_CONVERSATION_PROVIDER value.",
    };
  if (!env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim())
    return {
      status: "not-configured",
      provider: "anthropic",
      model: null,
      reason: "Anthropic process credential is unavailable.",
    };
  const model = env.JARVIS_VOICE_CONVERSATION_MODEL?.trim() || DEFAULT_MODEL;
  if (
    model.length > 128 ||
    [
      bound(env, "JARVIS_VOICE_CONVERSATION_TIMEOUT_MS", 20_000, 120_000),
      bound(env, "JARVIS_VOICE_CONVERSATION_MAX_CALLS_PER_HOUR", 120, 10_000),
      bound(env, "JARVIS_VOICE_CONVERSATION_MAX_UTTERANCE_CHARS", 500, 10_000),
      bound(env, "JARVIS_VOICE_CONVERSATION_MAX_REPLY_CHARS", 600, 2_000),
      bound(env, "JARVIS_VOICE_CONVERSATION_HISTORY_MESSAGES", 12, 100),
    ].some((value) => value === null)
  )
    return {
      status: "not-configured",
      provider: "anthropic",
      model: null,
      reason: "Voice conversation limits or model are invalid.",
    };
  return {
    status: "configured",
    provider: "anthropic",
    model,
    reason: "Configured; no live provider probe has been performed.",
  };
}

export function createVoiceConversationFromEnv(env: Environment = process.env): {
  service: VoiceConversationService | null;
  status: VoiceConversationStatus;
} {
  const status = resolveVoiceConversationStatus(env);
  if (status.status !== "configured" || !status.model) return { service: null, status };
  const service = new VoiceConversationService({
    reasoner: createAnthropicVoiceReasoner({
      ...(env.ANTHROPIC_API_KEY?.trim()
        ? { apiKey: env.ANTHROPIC_API_KEY.trim() }
        : { authToken: env.ANTHROPIC_AUTH_TOKEN?.trim() }),
      model: status.model,
      timeoutMs: bound(env, "JARVIS_VOICE_CONVERSATION_TIMEOUT_MS", 20_000, 120_000)!,
    }),
    maxCallsPerHour: bound(env, "JARVIS_VOICE_CONVERSATION_MAX_CALLS_PER_HOUR", 120, 10_000)!,
    maxUtteranceLength: bound(env, "JARVIS_VOICE_CONVERSATION_MAX_UTTERANCE_CHARS", 500, 10_000)!,
    maxReplyLength: bound(env, "JARVIS_VOICE_CONVERSATION_MAX_REPLY_CHARS", 600, 2_000)!,
    historyLimit: bound(env, "JARVIS_VOICE_CONVERSATION_HISTORY_MESSAGES", 12, 100)!,
  });
  return { service, status };
}
