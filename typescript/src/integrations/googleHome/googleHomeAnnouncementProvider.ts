import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import googleHomeNotifier from "google-home-notifier";

export type GoogleHomeDevice = Readonly<{ name: string; address: string; port: number }>;

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
  readonly name: "google-home-notifier-v1";
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
  readonly name = "google-home-notifier-v1" as const;
  // google-home-notifier keeps target/volume state at module scope. Serialise
  // sends so concurrent governed actions cannot overwrite one another's state.
  private sendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pinnedTargets: ReadonlyMap<string, string>,
    private readonly discoveryTimeoutMs = 3_000,
  ) {}

  discover(timeoutMs = this.discoveryTimeoutMs): Promise<readonly GoogleHomeDevice[]> {
    return googleHomeNotifier.getDevices(timeoutMs);
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
    const run = this.sendTail.then(
      async () => {
        if (signal.aborted) throw signal.reason ?? new Error("announcement-aborted");
        if (
          attempt.target !== input.target ||
          this.pinnedTargets.get(input.target) !== attempt.address
        ) {
          throw new GoogleHomeAnnouncementError("google-home-prepared-target-mismatch");
        }

        const notifier = googleHomeNotifier
          .ip(attempt.address, "en-AU")
          .accent("com.au")
          .volume(input.volume ?? 0.45)
          .slow(false);

        const result = await notifier.notify(input.message);
        if (Array.isArray(result)) {
          const failed = result.find((entry) => "error" in entry);
          if (failed) throw new GoogleHomeAnnouncementError("google-home-notify-failed");
          return { target: input.target, result: "announced" } as const;
        }
        return { target: input.target, result: String(result) };
      },
      async () => {
        if (signal.aborted) throw signal.reason ?? new Error("announcement-aborted");
        throw new GoogleHomeAnnouncementError("google-home-send-queue-failed");
      },
    );
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
  return new LocalGoogleHomeAnnouncementProvider(targets);
}
