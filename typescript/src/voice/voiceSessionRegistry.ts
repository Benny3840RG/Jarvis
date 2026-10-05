/**
 * Server-authoritative registry of live {@link VoiceSession}s (#567).
 *
 * The confirmation lifecycle (arm → confirm/expire/replay) must be owned by the
 * server, not the client — otherwise a caller could forge or replay a
 * confirmation. The HTTP voice controller therefore keeps no state itself; it
 * holds one registry. Sessions are in-memory, idle-TTL evicted, and bounded in
 * number so an abusive caller cannot grow the map without limit.
 */

import { randomUUID } from "node:crypto";

import type { VoiceProfile } from "./voiceCommands.js";
import type { VoiceActuationProvider } from "./voiceHardware.js";
import { VoiceSession } from "./voiceSession.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 256;

export type VoiceSessionRegistryOptions = Readonly<{
  provider: VoiceActuationProvider;
  ttlMs?: number;
  maxSessions?: number;
  clock?: () => number;
  /** Confirmation TTL passed to each created session. */
  confirmationTtlMs?: number;
  /** Id generator (tests). */
  idFactory?: () => string;
}>;

type Entry = { session: VoiceSession; expiresAt: number };

export class VoiceSessionRegistry {
  readonly #provider: VoiceActuationProvider;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #clock: () => number;
  readonly #confirmationTtlMs: number | undefined;
  readonly #idFactory: () => string;
  readonly #sessions = new Map<string, Entry>();

  constructor(options: VoiceSessionRegistryOptions) {
    this.#provider = options.provider;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#clock = options.clock ?? Date.now;
    this.#confirmationTtlMs = options.confirmationTtlMs;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  create(profile: VoiceProfile): { id: string; profile: VoiceProfile; expiresAt: number } {
    const now = this.#clock();
    this.#evictExpired(now);
    while (this.#sessions.size >= this.#maxSessions) this.#evictOldest();
    const id = this.#idFactory();
    const session = new VoiceSession({
      profile,
      provider: this.#provider,
      clock: this.#clock,
      ...(this.#confirmationTtlMs === undefined
        ? {}
        : { confirmationTtlMs: this.#confirmationTtlMs }),
    });
    const expiresAt = now + this.#ttlMs;
    this.#sessions.set(id, { session, expiresAt });
    return { id, profile, expiresAt };
  }

  /** Resolve a live session, extending its idle TTL, or undefined if missing/expired. */
  get(id: string): VoiceSession | undefined {
    const now = this.#clock();
    const entry = this.#sessions.get(id);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.#sessions.delete(id);
      return undefined;
    }
    entry.expiresAt = now + this.#ttlMs;
    return entry.session;
  }

  /** Current expiry of a live session (for response metadata), or undefined. */
  expiresAt(id: string): number | undefined {
    return this.#sessions.get(id)?.expiresAt;
  }

  end(id: string): boolean {
    const now = this.#clock();
    const entry = this.#sessions.get(id);
    if (!entry) return false;
    if (now >= entry.expiresAt) {
      this.#sessions.delete(id);
      return false;
    }
    return this.#sessions.delete(id);
  }

  size(): number {
    return this.#sessions.size;
  }

  #evictExpired(now: number): void {
    for (const [id, entry] of this.#sessions) {
      if (now >= entry.expiresAt) this.#sessions.delete(id);
    }
  }

  #evictOldest(): void {
    // Insertion order == creation order for never-touched entries; for touched
    // ones the smallest expiresAt is the least-recently-active. Evict that.
    let oldestId: string | undefined;
    let oldestExpiry = Infinity;
    for (const [id, entry] of this.#sessions) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) this.#sessions.delete(oldestId);
  }
}
