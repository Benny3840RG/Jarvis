/**
 * NOLAN brain evaluation — a VoiceConversationReasoner over an OpenAI-compatible
 * chat completions endpoint (Ollama's /v1, llama.cpp's server, and similar).
 *
 * Evaluation only: it is not wired into the running server. It sends the same
 * system prompt and tool definitions as the production Claude reasoner and
 * applies the same rules: a proposal must be the turn's only tool use and must
 * validate against the proposal schema; a query result goes back as a tool
 * message; at most four model calls per turn.
 */

import {
  voiceConversationSystemPrompt,
  voiceConversationTools,
} from "../../voice/voiceAnthropicReasoner.js";
import type {
  ConversationReasonerInput,
  ReasonerResult,
  VoiceConversationReasoner,
} from "../../voice/voiceConversation.js";
import { voiceProposalSchema } from "../../voice/voiceProposal.js";

export type OpenAiCompatibleConfig = Readonly<{
  /** For example http://192.168.1.20:11434/v1 */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}>;

type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: unknown } };
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ChatResponse = {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }[];
};

type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Tool-call arguments arrive as a JSON string (OpenAI) or, on some servers, an object. */
function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function createOpenAiCompatibleVoiceReasoner(
  config: OpenAiCompatibleConfig,
  deps: { fetch?: Fetch } = {},
): VoiceConversationReasoner {
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive whole number of milliseconds.");
  }
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async reply(input: ConversationReasonerInput): Promise<ReasonerResult> {
      const tools = voiceConversationTools(input).map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      }));
      const messages: ChatMessage[] = [
        { role: "system", content: voiceConversationSystemPrompt(input) },
        ...input.history.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: input.transcript },
      ];
      let toolCalls = 0;
      for (let turn = 0; turn < 4; turn += 1) {
        if (turn > 0 && !input.reserveNextCall()) {
          return { status: "unavailable", reason: "rate-limited" };
        }
        const signal = input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)])
          : AbortSignal.timeout(config.timeoutMs);
        let payload: ChatResponse;
        try {
          const response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              tools,
              tool_choice: "auto",
              stream: false,
            }),
            signal,
          });
          if (!response.ok) return { status: "unavailable", reason: "provider-error" };
          payload = (await response.json()) as ChatResponse;
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
          ) {
            return { status: "unavailable", reason: "timeout" };
          }
          return { status: "unavailable", reason: "provider-error" };
        }
        const message = payload.choices?.[0]?.message;
        if (!message) return { status: "unavailable", reason: "provider-error" };
        const calls = message.tool_calls ?? [];
        if (calls.length === 0) {
          const text = (message.content ?? "").trim();
          return text
            ? { status: "answered", reply: text }
            : { status: "unavailable", reason: "provider-error" };
        }
        if (calls.some((call) => call.function?.name === "propose_change")) {
          // Same rule as production: a proposal ends the turn and is its only tool use.
          if (input.profile !== "client" || calls.length !== 1 || toolCalls > 0) {
            return { status: "unavailable", reason: "tool-limit" };
          }
          const parsed = voiceProposalSchema.safeParse(
            parseArguments(calls[0]!.function?.arguments),
          );
          if (!parsed.success) {
            input.rejectMalformedRequest();
            return { status: "unavailable", reason: "provider-error" };
          }
          return { status: "proposed", proposal: parsed.data };
        }
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
        for (const [index, call] of calls.entries()) {
          if (toolCalls >= 4) return { status: "unavailable", reason: "tool-limit" };
          toolCalls += 1;
          const args = parseArguments(call.function?.arguments) as
            { commandId?: unknown } | undefined;
          if (call.function?.name !== "voice_query" || typeof args?.commandId !== "string") {
            input.rejectMalformedRequest();
            return { status: "unavailable", reason: "provider-error" };
          }
          const answer = await input.query(args.commandId);
          messages.push({
            role: "tool",
            tool_call_id: call.id ?? `call-${turn}-${index}`,
            content: answer.status === "answered" ? answer.answer : answer.reason,
          });
        }
      }
      return { status: "unavailable", reason: "tool-limit" };
    },
  };
}
