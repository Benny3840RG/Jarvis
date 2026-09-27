import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import {
  castAnnouncement,
  discoverLocalCastDevices,
  type LocalCastDevice,
} from "./localCastTransport.js";

export type GoogleHomeDevice = LocalCastDevice;

export type GoogleHomeAnnouncementInput = Readonly<{
  target: string;
  message: string;
  volume?: number;
}>;

export type GoogleHomeAnnouncementAttempt = Readonly<{
  providerRequestId: string;
  providerCorrelationId: string;
  target: string;
  address: string;
}>;

export interface GoogleHomeAnnouncementProvider {
  readonly name: "google-cast-local-v1";
  discover(timeoutMs?: number): Promise<readonly GoogleHomeDevice[]>;
  prepare(input: GoogleHomeAnnouncementInput): Promise<GoogleHomeAnnouncementAttempt>;
  sendPrepared(
    attempt: GoogleHomeAnnouncementAttempt,
    input: GoogleHomeAnnouncementInput,
    signal: AbortSignal,
  ): Promise<Readonly<{ target: string; result: string }>>;
}

export class GoogleHomeAnnouncementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleHomeAnnouncementError";
  }
}

function parsePinnedTargets(value: string | undefined): ReadonlyMap<string, string> {
  if (!value?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GoogleHomeAnnouncementError("google-home-target-map-invalid-json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GoogleHomeAnnouncementError("google-home-target-map-invalid");
  }
  const entries = Object.entries(parsed).map(([name, address]) => {
    if (!name.trim() || typeof address !== "string" || isIP(address) !== 4) {
      throw new GoogleHomeAnnouncementError("google-home-target-map-invalid");
    }
    return [name.trim(), address] as const;
  });
  return new Map(entries);
}

export class LocalGoogleHomeAnnouncementProvider implements GoogleHomeAnnouncementProvider {
  readonly name = "google-cast-local-v1" as const;
  private sendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pinnedTargets: ReadonlyMap<string, string>,
    private readonly discoveryTimeoutMs = 4_000,
    private readonly voice = "en-au",
  ) {}

  discover(timeoutMs = this.discoveryTimeoutMs): Promise<readonly GoogleHomeDevice[]> {
    return discoverLocalCastDevices(timeoutMs);
  }

  async prepare(input: GoogleHomeAnnouncementInput): Promise<GoogleHomeAnnouncementAttempt> {
    const pinnedAddress = this.pinnedTargets.get(input.target);
    if (!pinnedAddress) {
      throw new GoogleHomeAnnouncementError("google-home-target-not-allowlisted");
    }
    return {
      providerRequestId: randomUUID(),
      providerCorrelationId: randomUUID(),
      target: input.target,
      address: pinnedAddress,
    };
  }

  async sendPrepared(
    attempt: GoogleHomeAnnouncementAttempt,
    input: GoogleHomeAnnouncementInput,
    signal: AbortSignal,
  ): Promise<Readonly<{ target: string; result: string }>> {
    const run = this.sendTail.then(async () => {
      if (signal.aborted) throw signal.reason ?? new Error("announcement-aborted");
      if (
        attempt.target !== input.target ||
        this.pinnedTargets.get(input.target) !== attempt.address
      ) {
        throw new GoogleHomeAnnouncementError("google-home-prepared-target-mismatch");
      }

      await castAnnouncement(
        attempt.address,
        input.message,
        input.volume ?? 0.45,
        signal,
        this.voice,
      );
      return { target: input.target, result: "announced" } as const;
    });
    this.sendTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createGoogleHomeAnnouncementProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleHomeAnnouncementProvider | null {
  const targets = parsePinnedTargets(env.JARVIS_GOOGLE_HOME_TARGETS_JSON);
  if (targets.size === 0) return null;
  const voice = env.JARVIS_GOOGLE_HOME_TTS_VOICE?.trim() || "en-au";
  return new LocalGoogleHomeAnnouncementProvider(targets, 4_000, voice);
}
