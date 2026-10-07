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

export type VoiceUtteranceCapture = Readonly<{
  title?: string;
  category?: string;
}>;

function parseProjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /\s/.test(value)) {
    throw new Error("projectId must be a non-empty identifier.");
  }
  return value;
}

function parseExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("expectedRevision must be a positive integer.");
  }
  return value;
}

function parseCaptureField(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    throw new Error(`${name} must be within its length limit.`);
  }
  return trimmed;
}

function parseCapture(value: unknown): VoiceUtteranceCapture | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capture must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "title" && key !== "category")
      throw new Error("capture contains an unknown field.");
  }
  const title = parseCaptureField(record.title, "capture.title", 200);
  const category = parseCaptureField(record.category, "capture.category", 100);
  return {
    ...(title === undefined ? {} : { title }),
    ...(category === undefined ? {} : { category }),
  };
}

export function parseVoiceUtterance(body: unknown): {
  transcript: string;
  isFinal: boolean;
  alternatives?: string[];
  heardTranscript?: string;
  projectId?: string;
  expectedRevision?: number;
  capture?: VoiceUtteranceCapture;
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
  const heardTranscript =
    record.heardTranscript === undefined ? undefined : parseTranscript(record.heardTranscript);
  const projectId = parseProjectId(record.projectId);
  const expectedRevision = parseExpectedRevision(record.expectedRevision);
  if ((projectId === undefined) !== (expectedRevision === undefined)) {
    throw new Error("projectId and expectedRevision must be supplied together.");
  }
  const capture = parseCapture(record.capture);
  return {
    transcript,
    isFinal: record.isFinal,
    ...(alternatives ? { alternatives } : {}),
    ...(heardTranscript === undefined ? {} : { heardTranscript }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(capture === undefined ? {} : { capture }),
  };
}
