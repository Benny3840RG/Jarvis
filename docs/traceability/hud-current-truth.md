# Jarvis HUD current truth

Date: 2026-08-21
Branch: `feat/jarvis-hud`
Base: `feat/business-invoice-foundation` (PR stack #384–#387)
Verification mode: local repository verification; no deployment or commissioning

## Role

The operator HUD remains a projection and control surface over existing Jarvis
HTTP and MCP contracts. It does not own jobs, quotes, invoices, approvals,
missions, evidence or completion.

## What this slice adds

- Presence mapping from authoritative `SystemStatus`, reconciliation health and
  proposed tool-action counts. Listening/processing/executing are not invented.
- Business view projecting HTTP registers that already exist on the invoice
  stack: customers, properties, enquiries and invoices. Each register degrades
  independently to UNAVAILABLE.
- Approvals view listing proposed tool actions for active brief projects.
  Proposal/approval/execution/reconciliation stay distinct. The HUD does not
  auto-approve and does not store `JARVIS_APPROVAL_TOKEN`.
- Diagnostics in System: presence, checked-at, reconciliation state and
  persistence authentication. No secrets, tokens or fake latency.
- Field/mobile: command capture remains visible; navigation is horizontally
  scrollable with larger targets.

## Backend integrations used

- `GET /api/v1/status`
- `GET /api/v1/tasks`
- `GET /api/v1/reminders`
- `GET /api/v1/brief`
- `GET /api/v1/quotes`
- `GET /api/v1/operations/inbox`
- `GET /api/v1/operations/activity`
- `GET /api/v1/clients`
- `GET /api/v1/properties`
- `GET /api/v1/enquiries`
- `GET /api/v1/invoices`
- `GET /api/v1/projects/{projectId}/tool-actions`

Mutating HUD operations remain the existing MCP tools: `create_task`,
`complete_task`, `create_reminder`, `get_quote`.

## Intentionally unavailable

- Jarvis conversation/voice runtime (no HTTP conversation surface).
- Live Outlook send/reconcile (commissioning blocked; integrations render as
  not-commissioned from status).
- Calendar authority (no calendar API).
- HUD-side approve/reject/execute of tool actions (governed HTTP path with a
  separate approval token).
- Site assessment, variations, work-order scheduling, invoice PDFs (backend
  slices not on this stack).
- Production Convex / remote MCP exposure.

## Dependency

This HUD branch must not land on `main` before the business stack it reads
(`#384`–`#387`) unless those HTTP routes are first available on `main`.
