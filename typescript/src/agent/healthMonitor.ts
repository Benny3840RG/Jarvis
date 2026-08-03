export interface HealthMetric {
  name: string;
  value: number;
  status: "ok" | "warning" | "critical";
}

export type HealthStatus = "ok" | "warning" | "critical" | "unknown";

export class HealthMonitor {
  constructor(private readonly metrics: HealthMetric[] = []) {}

  getMetrics(): HealthMetric[] {
    return this.metrics;
  }

  overallStatus(): HealthStatus {
    if (this.metrics.length === 0) return "unknown";
    if (this.metrics.some((metric) => metric.status === "critical")) return "critical";
    if (this.metrics.some((metric) => metric.status === "warning")) return "warning";
    return "ok";
  }
}
