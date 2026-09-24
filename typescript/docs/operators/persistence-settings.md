# Settings → Persistence

The Persistence page is a control surface over the existing backup commands. It does not select a provider, merge archives, or invent a second recovery path (JARVIS-006).

Open it from the operator console **Settings** rail, then the Persistence tab (General, Credentials, Persistence, Danger zone). `show_persistence_settings` on the private MCP adapter opens the same read model. The tab reads `GET /api/v1/settings/persistence` and runs actions with `POST /api/v1/settings/persistence/actions`.

| Page action     | Command                                                              |
| --------------- | -------------------------------------------------------------------- |
| Export classic  | `npm run backup -- export <file>`                                    |
| Verify classic  | `npm run backup -- verify <file>`                                    |
| Restore classic | `npm run backup -- restore <file> --confirm-empty-target`            |
| Export v4       | `npm run backup -- export-v4 <file>`                                 |
| Verify v4       | `npm run backup -- verify-v4 <file>`                                 |
| Restore v4      | `npm run backup -- restore-v4 <file> <dir> --allow-partial`          |
| Resume v4       | `npm run backup -- restore-v4 <file> <dir> --allow-partial --resume` |

`npm run restore-drill` stays a development command. The page does not run it.

Provider selection stays in `.env.local` (`PERSISTENCE_PROVIDER`). The tab shows the active provider as read-only text and chips. It does not render provider radios and does not switch providers. Convex failure does not offer a JSON fallback. The health glance is provider plus health chips and a refresh. The primary cluster is **Backup / Export**. Backup is the sole primary control. Export sits beside it as a secondary control for the same classic export and is not a second primary. Restore stays inside the collapsed Classic and archive v4 sections and is not primary. Classic and archive v4 stay collapsed until opened. Resume is its own disclosure, not a control on Restore and not in the v4 restore row. Archive v4 export is refused while Convex is selected. v4 stays labeled Partial / JSON-only and is not a complete backup. Export copy states that archives must not contain service, approval, or delivery tokens. Classic restore requires the empty-target confirmation. v4 restore requires `--allow-partial` while the archive is partial and does not include a resume checkbox. Resume is a separate action and is never the default after a failure.

See [archive v4](archive-v4.md) and [ownership and concurrency](../architecture/ownership-and-concurrency.md).
