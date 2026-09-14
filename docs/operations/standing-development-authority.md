# Standing Development authority

Owner-approved Development operating envelope for routine Jarvis missions.

- Default uncertainty budget: `0.05`.
- Issue-specific budget variables remain optional overrides.
- Repository-wide `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET` remains an optional standing override.
- Routine application-code build, repair, CI rerun and independent review should proceed without per-mission owner intervention.
- Jarvis PASS is required before the owner merge decision.
- Merge remains owner-controlled.
- Production deployment and commissioning remain owner-controlled.
- Automation/workflow controls, secret/env material, dependency manifests, schema/config authority and deployment/governance controls remain outside unattended worker scope.

This authority is intended to reduce repetitive operator intervention, not to expand merge or deployment authority.
