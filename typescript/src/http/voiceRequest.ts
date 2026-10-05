/**
 * Request parsing for the voice HTTP boundary (#567). Each parser validates
 * strictly and throws on anything malformed; the controller maps a throw to a
 * 422 problem. Bounds on transcript/alternative sizes keep an abusive client
 * from forcing large work.
 */

import { VOICE_PROFILES, type VoiceProfile } from "../voice/voiceCommands.js";

const MAX_TRANSCRIPT_LENGTH = 512;
const MAX_ALTERNATIVES = 16;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("A JSON object body is required.");
  }
  return body as Record<string, unknown>;
}

function parseProfile(value: unknown): VoiceProfile {
  if (typeof value !== "string" || !(VOICE_PROFILES as readonly string[]).includes(value)) {
    throw new Error("A valid voice profile is required.");
  }
  return value as VoiceProfile;
}

function parseTranscript(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TRANSCRIPT_LENGTH) {
    throw new Error("transcript must be a string within the length limit.");
  }
  return value;
}

export function parseCreateVoiceSession(body: unknown): { profile: VoiceProfile } {
  const record = asRecord(body);
  return { profile: parseProfile(record.profile) };
}

export function parseSwitchVoiceProfile(body: unknown): { profile: VoiceProfile } {
  const record = asRecord(body);
  return { profile: parseProfile(record.profile) };
}

export function parseVoiceUtterance(body: unknown): {
  transcript: string;
  isFinal: boolean;
  alternatives?: string[];
} {
  const record = asRecord(body);
  const transcript = parseTranscript(record.transcript);
  if (typeof record.isFinal !== "boolean") {
    throw new Error("isFinal must be a boolean.");
  }
  let alternatives: string[] | undefined;
  if (record.alternatives !== undefined) {
    if (!Array.isArray(record.alternatives) || record.alternatives.length > MAX_ALTERNATIVES) {
      throw new Error("alternatives must be a bounded array of strings.");
    }
    alternatives = record.alternatives.map((item) => parseTranscript(item));
  }
  return { transcript, isFinal: record.isFinal, ...(alternatives ? { alternatives } : {}) };
}
