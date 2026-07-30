import { Controller, Get, Inject } from "@nestjs/common";

import type { AssetStore } from "../assets/asset.js";
import { buildOperationsInbox, type OperationsInbox } from "../operations/operationsInbox.js";
import type { PersistenceProvider } from "../persistence/persistence.js";
import { HTTP_ASSET_STORE, HTTP_PERSISTENCE } from "./tokens.js";

/**
 * Read-only Operations Inbox: what genuinely needs the operator's attention
 * now, derived only from existing authoritative stores. Each source is read
 * independently — see `buildOperationsInbox` — so one source failing never
 * fails this whole response or hides another source's items.
 */
@Controller("api/v1/operations/inbox")
export class OperationsInboxController {
  constructor(
    @Inject(HTTP_PERSISTENCE) private readonly persistence: PersistenceProvider,
    @Inject(HTTP_ASSET_STORE) private readonly assets: AssetStore,
  ) {}

  @Get()
  async get(): Promise<{ data: OperationsInbox }> {
    return {
      data: await buildOperationsInbox({
        now: Date.now(),
        listReminders: () => this.persistence.listReminders(),
        listAssets: () => this.assets.list(),
      }),
    };
  }
}
