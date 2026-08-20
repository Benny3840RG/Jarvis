# Jarvis Business Component Current Truth

Date: 2026-08-21
Scope: The Beez Treez Property Solutions business component
Verification mode: local repository verification; no deployment or commissioning

## Current truth

The business component is not complete on `main`.

The repository has a mature governed quote lifecycle slice, including quote
revisioning, finalisation, delivery-ledger tests, Outlook reconciliation
adapters, and commissioning gates. It does not yet contain a complete durable
business operating system for customers, properties, enquiries, assessments,
work orders, variations, invoices, payments, documents, reporting and field
dashboard workflows.

The legacy agent business domain remains explicitly simulation-scoped. Before
this repair, that simulation path could mark a business job `completed` without
completion evidence and without rejecting invalid state jumps. That contradicted
the business-component completion rule that a job must not become complete just
because a button or intent was triggered.

## Repaired safety gap

The agent business domain now:

- rejects `complete_job` unless at least one non-empty completion evidence
  reference is supplied;
- permits completion only from `in_progress`;
- rejects direct `scheduled -> completed` and other invalid terminal jumps;
- stores completion evidence references and a completion timestamp durably in
  the existing additive domain-state shape; and
- has a safety-envelope check that blocks completed job outputs that do not
  carry evidence.

This is an additive compatibility repair. Existing persisted jobs without
completion evidence remain readable. No customer, quote, job, invoice, evidence,
receipt, mission or proof row is rewritten or deleted.

## Durable property register slice

The business HTTP surface now includes a first durable property register for
client-owned service sites. The register stores:

- the owning `clientId`;
- the service address;
- site hazards;
- access notes; and
- service notes.

This follows the existing client-store pattern with JSON and in-memory stores,
authenticated HTTP routes, request validation, route/OpenAPI alignment and
durability tests. The property routes are deliberately documented as
`x-mcp-tool.exposed=false`; they are not yet advertised as MCP tools or bound to
governed autonomous actions.

This is still not the full work-order, assessment, job-costing, invoice, payment
or field-dashboard model. The JSON property register also does not yet enforce a
transactional client foreign key; that remains a Convex-backed migration concern
for a later slice.

## Verification

Focused verification:

- `node --import tsx --test tests/agentDomainPersistence.test.ts tests/agentSystem.test.ts`
- `npm run type-check`
- `npx prettier --check src/agent/businessEngine.ts src/agent/domainState.ts src/agent/safetyEnvelope.ts tests/agentDomainPersistence.test.ts tests/agentSystem.test.ts`
- `node --import tsx --test tests/agent*.test.ts tests/agentDomainPersistence.test.ts tests/safetyBinder.test.ts tests/safetyCategoryMatrix.test.ts`
- `node --import tsx --test tests/propertyStore.test.ts tests/propertyHttp.test.ts tests/httpRouteContract.test.ts tests/httpOpenApiRouteAlignment.test.ts`
- `npm run openapi:lint`

Full local repository gate:

- `npm run check`
- Result: exit 0.
- TypeScript type-check passed.
- ESLint passed.
- Prettier format check passed.
- OpenAPI lint passed.
- Node tests passed: 959 tests, 200 suites, 0 failures.
- Convex tests passed.

The full gate required execution outside the restricted sandbox because several
existing tests spawn child Node processes or bind loopback test servers on
`127.0.0.1`.

## Incidental verification repair

During full-gate verification, `convex/upgrades.test.ts` exposed a timestamp
flake: `upgrades.create` used two separate `Date.now()` calls for `createdAt`
and `updatedAt`, so the two fields could differ by one millisecond. The create
mutation now uses one timestamp for both fields, matching the existing build
create pattern. Focused `convex/upgrades.test.ts` passed after the repair.

## Still open

This slice does not commission or complete:

- AM-013 live quote delivery;
- delegated Outlook OAuth;
- Outlook reconciliation runtime against live Outlook;
- live Sentry or PostHog ingestion;
- production OIDC/remote gateway;
- production Convex deployment;
- production operations and recovery drills;
- durable customer/property/enquiry/assessment/work-order/variation/invoice/
  payment/reporting models for the full Beez Treez business scope; or
- a field-ready operational dashboard sourced from those durable models.

Those remain separately tracked by the open issue and PR queue. No live email,
customer effect, public exposure, production credential or deployment action was
performed in this slice.
