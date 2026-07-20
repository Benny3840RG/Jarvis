export interface HealthMetric {
  name: string;
  value: number;
  status: "ok" | "warning" | "critical";
}

export type HealthStatus = "ok" | "warning" | "critical";

export class HealthMonitor {
  constructor(private readonly metrics: HealthMetric[] = DEFAULT_METRICS) {}

  getMetrics(): HealthMetric[] {
    return this.metrics;
  }

  overallStatus(): HealthStatus {
    if (this.metrics.some((metric) => metric.status === "critical")) return "critical";
    if (this.metrics.some((metric) => metric.status === "warning")) return "warning";
    return "ok";
  }
}

// Placeholder metrics. Real latency / error-rate probes would be wired here.
const DEFAULT_METRICS: HealthMetric[] = [
  { name: "orchestrator_latency_ms", value: 20, status: "ok" },
  { name: "domain_errors_last_minute", value: 0, status: "ok" },
];
