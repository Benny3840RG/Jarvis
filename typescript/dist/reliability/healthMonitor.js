export class HealthMonitor {
    evaluate(services) {
        const issues = services.filter((service) => !service.healthy).map((service) => `${service.name} is unhealthy`);
        return {
            status: issues.length > 0 ? "warning" : "ok",
            issues,
        };
    }
}
