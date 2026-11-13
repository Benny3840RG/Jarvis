import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { JARVIS_INSTRUCTIONS } from "../mcp/persona.js";
import type { ConversationReasonerInput, VoiceConversationReasoner } from "./voiceConversation.js";

export type AnthropicVoiceConfig = Readonly<{
  apiKey?: string;
  authToken?: string;
  model: string;
  timeoutMs: number;
}>;

/** The SDK response is already parsed into typed content blocks and object inputs. */
export interface AnthropicVoiceMessages {
  parse(
    params: MessageCreateParamsNonStreaming,
    options?: { timeout?: number; signal?: AbortSignal; maxRetries?: number },
  ): Promise<Pick<BetaMessage, "stop_reason" | "content">>;
}

function systemPrompt(input: ConversationReasonerInput): string {
  const catalog = input.catalog
    .map((command) => `${command.id}: ${command.phrases.join(" / ")} — ${command.summary}`)
    .join("\n");
  return (
    `${JARVIS_INSTRUCTIONS}\n\nVoice conversation rules override tone where they differ. ` +
    "You have no ability to write, stage, approve, confirm, cancel, actuate, or change the profile. " +
    "Never claim an action happened. If Benny asks for an action, say plainly you have not done it " +
    "and give the catalogue phrase to say instead. Use the voice_query tool for every factual " +
    "business question. If its source is unavailable, say so; never guess from general knowledge. " +
    "Only the tool's spoken answer is authoritative for business facts. " +
    "Answer in one to three short spoken sentences, plain Australian English. No markdown, lists, " +
    "emoji, URLs, or code. Safety and governance outrank tone.\n\n" +
    `Active profile: ${input.profile}. Catalogue phrases:\n${catalog}`
  );
}

function parsedCommandId(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const commandId = (value as Record<string, unknown>).commandId;
  return typeof commandId === "string" && allowed.has(commandId) ? commandId : null;
}

export function createAnthropicVoiceReasoner(
  config: AnthropicVoiceConfig,
  deps: { client?: AnthropicVoiceMessages } = {},
): VoiceConversationReasoner {
  const client =
    deps.client ??
    new Anthropic(config.apiKey ? { apiKey: config.apiKey } : { authToken: config.authToken }).beta
      .messages;
  return {
    async reply(input) {
      const ids = input.catalog.filter((command) => command.kind === "query").map((c) => c.id);
      const allowed = new Set(ids);
      const messages: BetaMessageParam[] = [
        ...input.history.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: input.transcript },
      ];
      let toolCalls = 0;
      let unavailableSource: string | undefined;
      for (let turn = 0; turn < 4; turn += 1) {
        if (turn > 0 && !input.reserveNextCall()) {
          return { status: "unavailable", reason: "rate-limited" };
        }
        try {
          const response = await client.parse(
            {
              model: config.model,
              max_tokens: 2000,
              output_config: { effort: "low" },
              system: systemPrompt(input),
              messages,
              tools: [
                {
                  name: "voice_query",
                  description:
                    "Read the existing authoritative spoken answer for one query in the active voice profile.",
                  input_schema: {
                    type: "object",
                    properties: { commandId: { type: "string", enum: ids } },
                    required: ["commandId"],
                    additionalProperties: false,
                  },
                },
              ],
              tool_choice: { type: "auto" },
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            {
              timeout: config.timeoutMs,
              ...(input.signal ? { signal: input.signal } : {}),
              maxRetries: 0,
            },
          );
          // Never inspect content until the termination class has been accepted.
          if (response.stop_reason === "refusal")
            return { status: "unavailable", reason: "refused" };
          if (response.stop_reason === "max_tokens")
            return { status: "unavailable", reason: "provider-error" };
          if (response.stop_reason === "end_turn") {
            if (unavailableSource) return { status: "answered", reply: unavailableSource };
            const text = response.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(" ")
              .trim();
            return text
              ? { status: "answered", reply: text }
              : { status: "unavailable", reason: "provider-error" };
          }
          if (response.stop_reason !== "tool_use")
            return { status: "unavailable", reason: "provider-error" };
          if (unavailableSource) return { status: "answered", reply: unavailableSource };
          const uses = response.content.filter((block) => block.type === "tool_use");
          if (!uses.length || toolCalls + uses.length > 4)
            return { status: "unavailable", reason: "tool-limit" };
          const results: BetaToolResultBlockParam[] = [];
          for (const use of uses) {
            if (use.name !== "voice_query")
              return { status: "unavailable", reason: "provider-error" };
            const commandId = parsedCommandId(use.input, allowed);
            if (!commandId) return { status: "unavailable", reason: "provider-error" };
            const answer = await input.query(commandId);
            if (answer.status === "unavailable") unavailableSource ??= answer.reason;
            results.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: answer.status === "answered" ? answer.answer : answer.reason,
            });
            toolCalls += 1;
          }
          // Append the assistant turn exactly as returned. Its thinking blocks are bound to
          // this conversation and must precede the tool results unchanged; dropping or
          // rebuilding them is a history edit the current models reject.
          messages.push({
            role: "assistant",
            content: response.content as BetaContentBlockParam[],
          });
          messages.push({ role: "user", content: results });
        } catch (error) {
          if (error instanceof Anthropic.RateLimitError)
            return { status: "unavailable", reason: "rate-limited" };
          if (error instanceof Anthropic.APIConnectionTimeoutError)
            return { status: "unavailable", reason: "timeout" };
          if (error instanceof Anthropic.APIUserAbortError)
            return { status: "unavailable", reason: "unavailable" };
          if (error instanceof Anthropic.APIConnectionError)
            return { status: "unavailable", reason: "provider-error" };
          if (error instanceof Anthropic.APIError)
            return { status: "unavailable", reason: "provider-error" };
          return { status: "unavailable", reason: "provider-error" };
        }
      }
      return unavailableSource
        ? { status: "answered", reply: unavailableSource }
        : { status: "unavailable", reason: "tool-limit" };
    },
  };
}
