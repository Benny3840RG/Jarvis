/**
 * Read-only voice query boundary (LV1-04).
 *
 * The session asks a provider; it does not read stores itself. A missing
 * provider stays `query-unavailable`. A connected provider either returns an
 * answer derived from an existing Jarvis read model or an unavailable result
 * that names the source. It never invents a count.
 */

export type VoiceQueryAnswer =
  | Readonly<{ status: "answered"; answer: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type VoiceQueryRequest = Readonly<{
  commandId: string;
  now: number;
}>;

export interface VoiceQueryProvider {
  answer(input: VoiceQueryRequest): Promise<VoiceQueryAnswer>;
}
