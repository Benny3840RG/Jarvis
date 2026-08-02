# Dashboard Operations Projection Design

## Objective

Project the existing daily brief into the Jarvis dashboard snapshot so the command centre shows real operational work: active projects, quote pipeline, due reminders and equipment maintenance.

## Boundaries

- Reuse the authenticated `GET /api/v1/brief` endpoint and existing `DailyBrief` type.
- Add `brief: DailyBrief` to `DashboardSnapshot`.
- Fetch status, tasks, reminders and brief concurrently.
- Extend the existing MCP output schema and declared operation map.
- Render an Operations view inside the existing dashboard resource.
- Keep the live activity feed session-only.
- Do not add schema fields, persistence paths, permissions, credentials, deployment changes or invented telemetry.

## Data flow

`show_jarvis_dashboard` calls `JarvisApiClient.dashboard()`. That method concurrently reads status, tasks, reminders and the daily brief. The MCP server validates the complete snapshot and returns it as structured content. The embedded dashboard stores `brief` and renders four truthful projections: headline, active projects, quote pipeline and maintenance due/due soon.

## Failure behaviour

The dashboard snapshot remains fail-closed: if any required read fails, the existing safe MCP error is returned rather than a partial snapshot that could look complete. Empty collections render explicit calm empty states. Session activity remains labelled SESSION and is never persisted or presented as durable history.

## Testing

- A focused client test proves `dashboard()` requests the brief and returns it unchanged.
- MCP protocol fixtures prove the structured output contains the brief.
- Operation-binding tests prove the dashboard read contract includes `GET /api/v1/brief`.
- Widget tests cover the Operations view wiring, truthful labels and JavaScript syntax.
- Full TypeScript checks remain the merge gate.
