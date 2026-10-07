# Settings → Persistence

The Persistence page is a control surface over the existing backup commands. It does not select a provider, merge archives, or invent a second recovery path (JARVIS-006).

Open it from the operator console **Settings** rail, then the Persistence tab (General, Credentials, Persistence, Limits, Danger zone). `show_persistence_settings` on the private MCP adapter opens the same read model. The tab reads `GET /api/v1/settings/persistence` and runs actions with `POST /api/v1/settings/persistence/actions`.

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

Provider selection stays in `.env.local` (`PERSISTENCE_PROVIDER`). The tab shows the active provider as read-only text and chips. It does not render provider radios and does not switch providers. Convex failure does not offer a JSON fallback. The health glance is provider plus health chips and a refresh. **Backup** is the one primary action. Classic and archive v4 stay collapsed until opened. Archive v4 export is refused while Convex is selected. v4 stays labeled Partial / JSON-only and is not a complete backup. Export copy states that archives must not contain service, approval, or delivery tokens. Classic restore requires the empty-target confirmation. v4 restore requires `--allow-partial` while the archive is partial and does not include a resume checkbox. Resume is a separate action and is never the default after a failure.

Checkout-local business files live under `typescript/data/` for the checkout that started the process. `JARVIS_DATA_DIR` points one process at another directory of the same JSON files. Classic restore writes the live provider. Archive v4 full recovery is still refused; `--allow-partial` is not that recovery. The Local V1 gate is `proveLocalV1Recovery` in [archive v4](archive-v4.md): a scratch JSON directory, an injected empty database, and two injected reads. A restarted `src/http/main.ts` matches client, task, and build GETs from scratch JSON. The quote GET on that restarted process is **NOT YET MET** and is still owed under LV1-10 or LV1-11, against an isolated local Convex backend that is not the configured `CONVEX_URL`. It does not write the configured Convex deployment. `completeness` stays `partial`. Recovery is not complete.

See [archive v4](archive-v4.md) and [ownership and concurrency](../architecture/ownership-and-concurrency.md).
