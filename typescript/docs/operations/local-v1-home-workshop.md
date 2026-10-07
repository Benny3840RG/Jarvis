# Local V1 home and workshop surfaces

Tracker: #697, work items LV1-07 and LV1-08. This is the off-host map of the paths that already exist. It is not host commissioning. Voice wiring is a separate track; this page only names the endpoints and MCP tools that track should call.

## Persistence

`PERSISTENCE_PROVIDER` defaults to `json`. `convex` is opt-in and needs `CONVEX_URL`. Selection is `selectMemoryStore` in `src/http/app.ts` unless a row below says otherwise.

| Record     | JSON file when the provider is `json`    | When the provider is `convex`                                       |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Tasks      | `typescript/data/jarvis-state.json`      | Convex, same `PersistenceProvider` operations                       |
| Reminders  | `typescript/data/jarvis-state.json`      | Convex, same `PersistenceProvider` operations                       |
| Errands    | `typescript/data/jarvis-errands.json`    | Still that JSON file. Errands do not follow `PERSISTENCE_PROVIDER`. |
| Builds     | `typescript/data/jarvis-builds.json`     | Convex                                                              |
| Build logs | `typescript/data/jarvis-build-logs.json` | Convex                                                              |
| Upgrades   | `typescript/data/jarvis-upgrades.json`   | Convex                                                              |
| Assets     | `typescript/data/jarvis-assets.json`     | Convex                                                              |

Restart proof in `tests/localV1HomeWorkshopFlow.test.ts` uses those JSON stores, closes the app, and opens a new app on the same files. A Convex restart was not run in the off-host exercise.

## Home: tasks, reminders, errands

Reminders have no completed flag. Removing one is `delete_reminder` / `DELETE /api/v1/reminders/{reminderId}`. The governed tool name for a controlled reminder is `reminders:cancel`. Errands complete by `update_errand` with `status: "done"`, which stamps `completedAt`. Tasks complete by `complete_task` / `POST /api/v1/tasks/{taskId}/complete`.

Daily brief: `GET /api/v1/brief` and MCP `get_daily_brief`. Open tasks, due reminders, and open errands are sections of that brief. HUD: `GET /api/v1/hud/snapshot` (loopback) includes the same brief plus the task and reminder lists.

| Intent                    | MCP tool          | HTTP                                    |
| ------------------------- | ----------------- | --------------------------------------- |
| List tasks                | `list_tasks`      | `GET /api/v1/tasks`                     |
| Read one task             | `get_task`        | `GET /api/v1/tasks/{taskId}`            |
| Create task               | `create_task`     | `POST /api/v1/tasks`                    |
| Update task               | `update_task`     | `PATCH /api/v1/tasks/{taskId}`          |
| Complete task             | `complete_task`   | `POST /api/v1/tasks/{taskId}/complete`  |
| Delete task               | `delete_task`     | `DELETE /api/v1/tasks/{taskId}`         |
| List reminders            | `list_reminders`  | `GET /api/v1/reminders`                 |
| Read one reminder         | `get_reminder`    | `GET /api/v1/reminders/{reminderId}`    |
| Create reminder           | `create_reminder` | `POST /api/v1/reminders`                |
| Update reminder           | `update_reminder` | `PATCH /api/v1/reminders/{reminderId}`  |
| Remove reminder           | `delete_reminder` | `DELETE /api/v1/reminders/{reminderId}` |
| List errands              | `list_errands`    | `GET /api/v1/errands`                   |
| Read one errand           | `get_errand`      | `GET /api/v1/errands/{errandId}`        |
| Create errand             | `create_errand`   | `POST /api/v1/errands`                  |
| Update or complete errand | `update_errand`   | `PATCH /api/v1/errands/{errandId}`      |
| Delete errand             | `delete_errand`   | `DELETE /api/v1/errands/{errandId}`     |
| Daily brief               | `get_daily_brief` | `GET /api/v1/brief`                     |
| HUD snapshot              | none              | `GET /api/v1/hud/snapshot`              |

Task and reminder creates need an `Idempotency-Key`. The MCP client sends one. There is no MCP tool for the HUD snapshot; voice should call `get_daily_brief` or the HTTP snapshot.

## Workshop

| Intent                               | MCP tool           | HTTP                                  |
| ------------------------------------ | ------------------ | ------------------------------------- |
| List builds                          | `list_builds`      | `GET /api/v1/builds`                  |
| Read one build                       | `get_build`        | `GET /api/v1/builds/{buildId}`        |
| Create build                         | `create_build`     | `POST /api/v1/builds`                 |
| Update build                         | `update_build`     | `PATCH /api/v1/builds/{buildId}`      |
| Delete build                         | `delete_build`     | `DELETE /api/v1/builds/{buildId}`     |
| List build log                       | `list_build_log`   | `GET /api/v1/build-logs`              |
| Read one log entry                   | `get_build_log`    | `GET /api/v1/build-logs/{entryId}`    |
| Append a log entry                   | `create_build_log` | `POST /api/v1/build-logs`             |
| Update a log entry                   | `update_build_log` | `PATCH /api/v1/build-logs/{entryId}`  |
| Delete a log entry                   | `delete_build_log` | `DELETE /api/v1/build-logs/{entryId}` |
| List upgrades                        | `list_upgrade`     | `GET /api/v1/upgrades`                |
| Read one upgrade                     | `get_upgrade`      | `GET /api/v1/upgrades/{upgradeId}`    |
| Record an upgrade                    | `create_upgrade`   | `POST /api/v1/upgrades`               |
| Update an upgrade                    | `update_upgrade`   | `PATCH /api/v1/upgrades/{upgradeId}`  |
| Delete an upgrade                    | `delete_upgrade`   | `DELETE /api/v1/upgrades/{upgradeId}` |
| List assets                          | `list_asset`       | `GET /api/v1/assets`                  |
| Read one asset                       | `get_asset`        | `GET /api/v1/assets/{assetId}`        |
| Create asset                         | `create_asset`     | `POST /api/v1/assets`                 |
| Update asset, including last service | `update_asset`     | `PATCH /api/v1/assets/{assetId}`      |
| Delete asset                         | `delete_asset`     | `DELETE /api/v1/assets/{assetId}`     |

Maintenance status is derived on read from `serviceIntervalDays` and `lastServicedAt`. It is not a stored scheduler. Due and overdue assets appear in the brief `maintenance` section and in `get_operations_inbox`.

Workshop tasks are ordinary tasks with category `workshop`. They use the task tools above.

## Questions the current records can and cannot answer

| Question                                   | Authoritative read                                                         | Write                                           | Gap                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What am I working on?                      | `list_builds`, keep `status: "active"`                                     | `create_build` / `update_build`                 | Active builds are not a section of the daily brief or HUD snapshot.                                                                                                                  |
| When was the compressor last serviced?     | `get_asset` / `list_asset` field `lastServicedAt` for the compressor asset | `update_asset` with `lastServicedAt`            | One date only. Earlier services are not a history.                                                                                                                                   |
| Add bearings to the crawler parts list.    | None                                                                       | None                                            | There is no parts-list record. `upgrade.parts` is the parts used in one recorded change, not a wanted-parts list. An errand can remember a pickup, and it is not a build parts list. |
| Log that the rear bracket has been welded. | `get_build_log` / `list_build_log`                                         | `create_build_log` with the crawler's `buildId` | None for this sentence.                                                                                                                                                              |

Voice reads should call the MCP tools in the tables. Voice writes should call those same tools. Announcements stay on `home:announce` through ToolAction, not an MCP tool. See `google-home-announcements.md`.
