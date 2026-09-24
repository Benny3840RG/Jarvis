# Settings → Limits

Limits is the operator read model for provider quotas. The durable store is not selected, so the page does not enforce a limit and does not save one.

Open it from the operator console **Settings** rail. The tab order is General, Credentials, Persistence, Limits, Danger zone. The authority page is loopback `GET /settings/limits`. The console HUD shows one NOW chip, `Limits · UNKNOWN`, and that chip links to `/settings/limits`. The chip is not an editor.

| Resource            | Soft | Hard         | Chip while the store is unread | Reset period |
| ------------------- | ---- | ------------ | ------------------------------ | ------------ |
| API / provider rate | Soft | No hard stop | UNKNOWN                        | Unknown      |
| Concurrency         | Soft | No hard stop | UNKNOWN                        | Unknown      |
| Storage / backup    | Soft | No hard stop | UNKNOWN                        | Unknown      |
| Retention           | Soft | No hard stop | UNKNOWN                        | Unknown      |
| Delivery            | Soft | No hard stop | UNKNOWN                        | Unknown      |

Chip vocabulary is OK, WARN, STOPPED, UNKNOWN, and NO LIMIT. The one NOW chip ranks STOPPED above UNKNOWN above WARN above OK. An unread quota outranks a soft warn. An unread store never renders OK and never invents a remaining count. Change-limit confirmation is `CHANGE LIMIT`. Submitting it reports that nothing was enforced. The page does not write Convex, JSON, or environment quota values, and it does not keep a Bearer token.

Seats, billing, and paywall are not on this page. There is no team-admin path. Notifications and Sessions are not settings tabs.

See [persistence settings](persistence-settings.md) and [danger zone](danger-zone.md).
