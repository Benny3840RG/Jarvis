export interface HealthMetric {
  readonly name: string;
  readonly value: number;
  readonly status: "ok" | "warning" | "critical";
}

export type HealthStatus = "ok" | "warning" | "critical" | "unknown";

export class HealthMonitor {
  private readonly metrics: readonly Readonly<HealthMetric>[];

  constructor(metrics: readonly HealthMetric[] = []) {
    this.metrics = Object.freeze(metrics.map((metric) => Object.freeze({ ...metric })));
  }

  getMetrics(): readonly Readonly<HealthMetric>[] {
    return this.metrics;
  }

  overallStatus(): HealthStatus {
    if (this.metrics.length === 0) return "unknown";
    if (this.metrics.some((metric) => metric.status === "critical")) return "critical";
    if (this.metrics.some((metric) => metric.status === "warning")) return "warning";
    return "ok";
  }
}
