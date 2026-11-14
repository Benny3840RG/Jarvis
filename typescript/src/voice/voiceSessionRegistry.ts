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
import type { VoiceQueryProvider } from "./voiceQuery.js";
import { VoiceSession } from "./voiceSession.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export type VoiceSessionRegistryOptions = Readonly<{
  provider: VoiceActuationProvider;
  queries?: VoiceQueryProvider;
  ttlMs?: number;
  maxSessions?: number;
  clock?: () => number;
  /** Confirmation TTL passed to each created session. */
  confirmationTtlMs?: number;
  /** Enable natural-language interpretation (behind confirmation) in each session. */
  interpretNaturalLanguage?: boolean;
  /** Id generator (tests). */
  idFactory?: () => string;
  /**
   * How often expired sessions are swept so removal listeners run without waiting for
   * another registry call (default 60 s; 0 disables the timer). The timer never holds
   * the process open.
   */
  sweepIntervalMs?: number;
}>;

type Entry = { session: VoiceSession; expiresAt: number };

export class VoiceSessionRegistry {
  readonly #provider: VoiceActuationProvider;
  readonly #queries: VoiceQueryProvider | undefined;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #clock: () => number;
  readonly #confirmationTtlMs: number | undefined;
  readonly #interpretNaturalLanguage: boolean;
  readonly #idFactory: () => string;
  readonly #sessions = new Map<string, Entry>();
  readonly #sweepIntervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #removalListener: ((session: VoiceSession) => void) | undefined;

  /** Observe disposal without giving the observer control over session decisions. */
  onRemove(listener: (session: VoiceSession) => void): void {
    this.#removalListener = listener;
  }

  constructor(options: VoiceSessionRegistryOptions) {
    this.#provider = options.provider;
    this.#queries = options.queries;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#clock = options.clock ?? Date.now;
    this.#confirmationTtlMs = options.confirmationTtlMs;
    this.#interpretNaturalLanguage = options.interpretNaturalLanguage ?? false;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * Stop the sweep timer and drop every session (notifying the removal listener). Idempotent;
   * the registry stays usable, and a later create() re-arms the timer.
   */
  dispose(): void {
    this.#stopTimer();
    for (const id of [...this.#sessions.keys()]) this.#delete(id);
  }

  // The timer exists only while sessions do, so an idle or abandoned registry is never
  // referenced by a timer; it is unref'd so it never holds the process open either.
  #armTimer(): void {
    if (this.#timer || this.#sweepIntervalMs <= 0 || this.#sessions.size === 0) return;
    this.#timer = setInterval(() => this.sweep(), this.#sweepIntervalMs);
    this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Remove every expired session now, notifying the removal listener for each. */
  sweep(): void {
    this.#evictExpired(this.#clock());
  }

  create(profile: VoiceProfile): { id: string; profile: VoiceProfile; expiresAt: number } {
    const now = this.#clock();
    this.#evictExpired(now);
    while (this.#sessions.size >= this.#maxSessions) this.#evictOldest();
    const id = this.#idFactory();
    const session = new VoiceSession({
      profile,
      provider: this.#provider,
      ...(this.#queries === undefined ? {} : { queries: this.#queries }),
      clock: this.#clock,
      ...(this.#confirmationTtlMs === undefined
        ? {}
        : { confirmationTtlMs: this.#confirmationTtlMs }),
      interpretNaturalLanguage: this.#interpretNaturalLanguage,
    });
    const expiresAt = now + this.#ttlMs;
    this.#sessions.set(id, { session, expiresAt });
    this.#armTimer();
    return { id, profile, expiresAt };
  }

  /** Resolve a live session, extending its idle TTL, or undefined if missing/expired. */
  get(id: string): VoiceSession | undefined {
    const now = this.#clock();
    const entry = this.#sessions.get(id);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.#delete(id);
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
      this.#delete(id);
      return false;
    }
    return this.#delete(id);
  }

  size(): number {
    return this.#sessions.size;
  }

  #evictExpired(now: number): void {
    for (const [id, entry] of this.#sessions) {
      if (now >= entry.expiresAt) this.#delete(id);
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
    if (oldestId !== undefined) this.#delete(oldestId);
  }

  #delete(id: string): boolean {
    const entry = this.#sessions.get(id);
    if (!entry) return false;
    this.#sessions.delete(id);
    if (this.#sessions.size === 0) this.#stopTimer();
    this.#removalListener?.(entry.session);
    return true;
  }
}
