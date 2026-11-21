# NOLAN situation snapshot

`GET /api/v1/situation` (service token required) returns a read-only summary of
what is going on now, built from the read models Jarvis already has. The MCP
tool `get_situation_snapshot` returns the same schema-validated snapshot through
the existing MCP-to-HTTP service-token client. It takes no arguments and is
model-visible, with no HUD or voice wiring.

## Fields

| Field                             | Source                                                    | Freshness                        |
| --------------------------------- | --------------------------------------------------------- | -------------------------------- |
| `localTime`                       | the clock, in `JARVIS_TIMEZONE`                           | live                             |
| `systemHealth`                    | the system status service (persistence check)             | live                             |
| `nolanBrain`                      | voice conversation configuration (no live model call)     | live                             |
| `reconciliation`                  | the runtime reconciliation host's last successful cycle   | cached, or stale past its window |
| `openTasks`                       | task records                                              | live                             |
| `reminders`                       | reminder records: due, and coming up in the next 24 hours | live                             |
| `jobsToday`                       | the project schedule, today in the operator timezone      | live                             |
| `pendingApprovals`                | governed ToolAction proposals (count only)                | live                             |
| `calendar`, `presence`, `devices` | none commissioned                                         | always unknown                   |

Every field has `status` (`available`, `unavailable` or `unknown`), `source`,
`observedAt` and `freshness` (`live`, `cached`, `stale` or `unknown`).

## Rules

- **Not observed means no value.** An `unavailable` (a source failed or is not
  connected) or `unknown` (nothing observes it) field has no value, freshness
  `unknown`, `observedAt: null` and a `reason`. It is never shown as healthy or
  current.
- **Cached is never live.** Reconciliation reports its last successful cycle as
  `cached` while it is inside the host's freshness window and `stale` after.
- **Nothing is invented.** Calendar, presence and device state stay `unknown`
  until a source is commissioned (devices depend on the #836 registry). Presence
  is never inferred from network or device activity.
- **Time needs a valid timezone.** If `JARVIS_TIMEZONE` is invalid, `timezone`
  is `null` and the time-dependent fields are `unknown`.
- **Read-only.** It lists and counts; it never stages, approves, rejects or
  executes a ToolAction and never actuates a device. Titles are capped at five
  per field. No tokens or private record fields are included.

The snapshot is not shown on the HUD or wired into voice in this slice.
