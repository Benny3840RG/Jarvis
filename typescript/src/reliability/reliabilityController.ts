import type { LayerStatus } from "../http/contracts.js";

export type ReliabilityCircuitState = "closed" | "open" | "half-open";

export type ReliabilitySnapshot = {
  state: ReliabilityCircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureCode?: "probe-failed";
  lastCheckedAt?: number;
};

export class CircuitOpenError extends Error {
  readonly code = "circuit-open";

  constructor() {
    super("Reliability circuit is open.");
    this.name = "CircuitOpenError";
  }
}

export type ReliabilityControllerOptions = {
  clock?: () => number;
  failureThreshold?: number;
  cooldownMs?: number;
};

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5_000;

class CircuitBreaker {
  private state: ReliabilityCircuitState = "closed";
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureCode: "probe-failed" | undefined;
  private lastCheckedAt: number | undefined;
  private openedAt: number | undefined;
  private halfOpenProbeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  tryAcquire(now: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.openedAt === undefined || now - this.openedAt < this.cooldownMs) return false;
      this.state = "half-open";
    }
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  recordSuccess(now: number): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.totalSuccesses += 1;
    this.lastCheckedAt = now;
    this.halfOpenProbeInFlight = false;
    this.openedAt = undefined;
  }

  recordFailure(now: number): void {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    this.lastFailureCode = "probe-failed";
    this.lastCheckedAt = now;
    this.halfOpenProbeInFlight = false;
    if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  snapshot(): ReliabilitySnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      ...(this.lastFailureCode === undefined ? {} : { lastFailureCode: this.lastFailureCode }),
      ...(this.lastCheckedAt === undefined ? {} : { lastCheckedAt: this.lastCheckedAt }),
    };
  }
}

export class ReliabilityController {
  private readonly clock: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly observedOutcomes = new Map<string, "success" | "failure">();

  constructor(options: ReliabilityControllerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (!Number.isSafeInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new Error("Reliability failure threshold must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1) {
      throw new Error("Reliability cooldown must be a positive safe integer.");
    }
  }

  async run<T>(dependency: string, probe: () => Promise<T>): Promise<T> {
    const breaker = this.breakerFor(dependency);
    if (!breaker.tryAcquire(this.clock())) throw new CircuitOpenError();
    try {
      const result = await probe();
      breaker.recordSuccess(this.clock());
      this.observedOutcomes.set(dependency, "success");
      return result;
    } catch (error) {
      breaker.recordFailure(this.clock());
      this.observedOutcomes.set(dependency, "failure");
      throw error;
    }
  }

  snapshot(dependency: string): ReliabilitySnapshot {
    return this.breakerFor(dependency).snapshot();
  }

  layerStatus(): LayerStatus {
    if (this.observedOutcomes.size === 0) {
      return {
        status: "inactive",
        reason: "No reliability probe evidence has been collected.",
      };
    }
    if ([...this.breakers.values()].some((breaker) => breaker.snapshot().state === "open")) {
      return {
        status: "blocked",
        reason: "A reliability circuit is open after repeated probe failures.",
      };
    }
    if ([...this.observedOutcomes.values()].some((outcome) => outcome === "failure")) {
      return {
        status: "partial",
        reason: "Persistence probe failed; the failure is recorded without raw provider details.",
      };
    }
    return {
      status: "partial",
      reason:
        "Persistence probe passed; recovery and external dependency probes remain uncommissioned.",
    };
  }

  private breakerFor(dependency: string): CircuitBreaker {
    const normalized = dependency.trim();
    if (!normalized) throw new Error("Reliability dependency is required.");
    const existing = this.breakers.get(normalized);
    if (existing) return existing;
    const breaker = new CircuitBreaker(this.failureThreshold, this.cooldownMs);
    this.breakers.set(normalized, breaker);
    return breaker;
  }
}
