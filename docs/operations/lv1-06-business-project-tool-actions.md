# LV1-06: business jobs and totality tool actions

Investigated 2026-10-07. Not implemented. Do not auto-create a totality project from a business job.

A business job from `POST /api/v1/projects` is a `ProjectStore` record. `POST /api/v1/projects/{projectId}/tool-actions` passes that id to the tool-action service as a totality `projectKey`. `convex/toolActions.ts` `requireProject` loads Convex table `projects` by `by_owner_and_project_key`. A missing row becomes HTTP 404 `urn:jarvis:problem:tool-action-not-found`.

The only writer of that table is the public mutation `projects.upsert` in `convex/projects.ts`. Application HTTP, MCP, and `src/totality` do not call it. Backup tests call it directly. `ConvexTotalityJournal.getProjectContext` only reads `projects.get`. There is no mapping from a business job id to a totality project key.

The existing operator step is to stage `quotes:finalize` and `quotes:send` against a totality project key that already exists. The Outlook commissioning kit reads that key (`JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY`) and refuses when `projects.get` returns null. It does not create the project.

Creating one from a business job would invent domains, revision, preferences, and status. That is a new authority path, not a reuse of the current tool-action gate. Stop there. Do not add an upsert route, a second approval path, or a change to ΩΣ or constitutional authority.
