# Standing Development authority

Owner-approved Development operating envelope for routine Jarvis missions.

- Default uncertainty budget: `0.05`.
- Issue-specific budget variables remain optional overrides for exceptional missions.
- Routine application-code build, bounded retry, repair, CI rerun and independent review should proceed without per-mission owner intervention.
- Tested reconciliation, persistence, integration and ordinary Convex implementation changes are permitted inside the bounded worker.
- Jarvis PASS is required before the owner merge decision.
- Merge remains owner-controlled.
- Production deployment and commissioning remain owner-controlled.
- Automation/workflow controls, secret/env material, dependency manifests, schema/config authority and deployment/governance controls remain outside unattended worker scope.
- Retryable pre-publication failures receive at most two automatic retries. Hard policy failures remain blocked and automatically request read-only Claude advice.

This authority is intended to reduce repetitive operator intervention, not to expand merge or deployment authority.
