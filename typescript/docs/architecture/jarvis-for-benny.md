# Jarvis for Benny — persistent assistant scope

Status: proposed (design/requirement doc for a staged build)

This document scopes turning Jarvis into a persistent, conversational assistant
for Benny that tracks business admin (clients, projects, quoting) and home life,
built on the maintained runtime. It is the durable requirement that the
[scaffold-and-runtime boundaries](./scaffold-and-runtime-boundaries.md) doc asks
for before adding new product domains.

## Vision

A single Jarvis that Benny talks to in natural language and that remembers
everything across restarts:

- business: clients, projects/jobs, quotes, tasks, reminders;
- home: shopping and errands, tied to where he is and what job he's on;
- proactive: it surfaces what needs attention ("quotes awaiting reply",
  "today's jobs", "get milk while you're at the shops").

It is the practical Jarvis, not the film's AGI: conversational and persistent,
honest about its limits.

## Foundation (decided)

Build on the **maintained runtime**, not the `src/agent/` simulation:

- **Persistence:** Convex (durable, multi-device) with the JSON provider as the
  local fallback — the same providers tasks/reminders already use.
- **API:** the existing always-on HTTP service.
- **Conversational front:** the existing ChatGPT/MCP adapter is the "Jarvis
  voice" today; a voice/mobile layer is a later tier.
- New domains are owner-scoped and protected by the existing service token, and
  every new endpoint/tool is automatically policed by the contract-integrity
  tests already in the repo (route↔OpenAPI parity, MCP↔OpenAPI binding).

## Capability tiers (honest feasibility)

### Tier A — buildable now (server-side, conversational)

Pure software on the current stack. This is what the staged build below delivers.

- **Clients** — name, contacts, notes.
- **Projects / jobs** — client, title, status (lead → quoted → active → done),
  notes; linked tasks and reminders.
- **Quotes** — client/project, number, line items (description, qty, unit price),
  subtotal / tax / total, status (draft → sent → accepted/declined), valid-until.
- **Location- and job-tagged reminders / shopping items** — e.g. "milk" tagged
  `@supermarket`, or "silicon ×2" tagged `@bunnings` and linked to a project.
  The item, its location tag, quantity, and project link are all stored durably
  and manageable by voice/text. (The _server_ holds these; see Tier B for the
  geofenced trigger.)
- **Briefs & summaries** — outstanding quotes, today's jobs, open errands — via
  the existing OpenAI reasoner.

### Tier B — needs a mobile app (location + push)

The **geofenced trigger** — "remind me when I'm actually at Bunnings" — requires
a phone app with GPS geofencing and push notifications. The server's job is to
store geofenced reminders and expose a sync/notify API; a separate mobile client
(e.g. React Native) registers geofences and fires the reminder on arrival. This
is a distinct app project, scoped separately once Tier A exists.

### Tier C — hardware + ML, long-horizon (safety caution)

Camera-based workshop monitoring ("watch me weld, warn if it's too hot") is a
real-time computer-vision + thermal-sensing research project needing dedicated
hardware. **Explicit safety boundary:** a homemade Jarvis feature is not welding
or machine-safety equipment and must never be presented or relied on as such —
proper PPE and rated gear remain the safety system. This tier is roadmap only,
with no near-term commitment, and if ever pursued is a monitoring aid at most.

## Domain model (Tier A)

Owner-scoped Convex tables, mirroring the existing `tasks`/`reminders` shape:

- **client** — `{ ownerId, clientId, name, contacts[], notes, createdAt, updatedAt }`
- **project** — `{ ownerId, projectId, clientId, title, status, notes, createdAt, updatedAt }`
- **quote** — `{ ownerId, quoteId, clientId, projectId?, number, status, lineItems[{description, quantity, unitPrice}], subtotal, tax?, total, validUntil?, createdAt, updatedAt }`
- **errand / shopping item** — `{ ownerId, itemId, label, quantity?, location?, projectId?, done, createdAt }`
- existing **task** / **reminder** — optionally gain a `projectId` link.

Totals are derived server-side from line items so they can't drift.

## Security and ownership

Single-operator, service-token auth (unchanged). Per
[ownership-and-concurrency](./ownership-and-concurrency.md), a real OIDC
user-auth model is required before any multi-user or public exposure — including
before a shared mobile app is opened beyond Benny.

## Staged build

Each stage is an isolated, tested PR through the full `npm run check` gate.

1. **Clients** — Convex schema + persistence + HTTP endpoints + MCP tools + OpenAPI, owner-scoped, smoke-tested.
2. **Projects** — linked to clients; task/reminder linkage.
3. **Quotes** — line items, derived totals, lifecycle; quote → project.
4. **Errands / location-tagged shopping items** — the durable Tier-A half of "milk @ shops", "silicon ×2 @ Bunnings for job X".
5. **Assistant intelligence** — briefs/summaries and proactive nudges over the above.
6. **Continuous deployment** — Convex prod + hosted HTTP service so it is genuinely always-on.
7. _(separate project)_ **Mobile app** — Tier B geofencing + push.

## Non-goals / honesty

- Not the film's AGI; not real-time voice out of the box (Tier B/voice later).
- Not a safety system for welding or machinery (Tier C caution above).
- No multi-user access until OIDC is added.
- The `src/agent/` simulation is unaffected and is not the basis for this work.
