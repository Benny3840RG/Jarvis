import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { BusinessEngine } from "../src/agent/businessEngine.js";
import {
  AGENT_DOMAIN_STATE_KEY,
  PersistentDomainStateStore,
} from "../src/agent/domainState.js";
import { HomeEngine } from "../src/agent/homeEngine.js";
import { WorkshopEngine } from "../src/agent/workshopEngine.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";

describe("durable agent domain state", () => {
  it("survives engine reconstruction across business, workshop and home domains", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-agent-domain-"));
    const filePath = path.join(directory, "state.json");

    try {
      const persistence = new JSONPersistence(filePath);
      const firstStore = new PersistentDomainStateStore(persistence);
      const business = new BusinessEngine(firstStore);
      const workshop = new WorkshopEngine(firstStore);
      const home = new HomeEngine(firstStore);

      const client = await business.handle("add_client", { name: "Kirsten" });
      assert.deepEqual(client, { id: "c2", name: "Kirsten" });
      const job = await business.handle("create_job", {
        clientId: "c2",
        description: "Clean tennis court",
      });
      assert.deepEqual(job, {
        id: "j3",
        clientId: "c2",
        description: "Clean tennis court",
        status: "new",
      });
      assert.deepEqual(await business.handle("start_job", { jobId: "j3" }), {
        id: "j3",
        clientId: "c2",
        description: "Clean tennis court",
        status: "in_progress",
      });
      assert.deepEqual(await workshop.handle("use_tool", { toolId: "t1" }), {
        id: "t1",
        name: "Drill",
        inUse: true,
      });
      assert.deepEqual(await workshop.handle("consume_item", { itemId: "i1", quantity: 5 }), {
        id: "i1",
        name: "Screws",
        quantity: 95,
      });
      assert.deepEqual(await home.handle("activate_scene", { sceneName: "arrival" }), {
        activated: "arrival",
        description: "Lights on, kettle on",
      });

      const secondStore = new PersistentDomainStateStore(persistence);
      const restoredBusiness = new BusinessEngine(secondStore);
      const restoredWorkshop = new WorkshopEngine(secondStore);
      const restoredHome = new HomeEngine(secondStore);

      assert.deepEqual(await restoredBusiness.handle("list_clients", {}), [
        { id: "c1", name: "Default Client" },
        { id: "c2", name: "Kirsten" },
      ]);
      assert.deepEqual(await restoredBusiness.handle("list_jobs", {}), [
        {
          id: "j3",
          clientId: "c2",
          description: "Clean tennis court",
          status: "in_progress",
        },
      ]);
      assert.deepEqual(await restoredWorkshop.handle("list_tools", {}), [
        { id: "t1", name: "Drill", inUse: true },
        { id: "t2", name: "Saw", inUse: false },
      ]);
      assert.deepEqual(await restoredWorkshop.handle("list_inventory", {}), [
        { id: "i1", name: "Screws", quantity: 95 },
        { id: "i2", name: "Timber", quantity: 20 },
      ]);
      assert.deepEqual(await restoredHome.handle("list_scenes", {}), [
        { name: "arrival", description: "Lights on, kettle on" },
        { name: "workshop_focus", description: "Workshop lights, music, tools ready" },
      ]);

      const state = await persistence.loadState();
      assert.equal(
        (state[AGENT_DOMAIN_STATE_KEY] as { version: number }).version,
        1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe inventory mutations at the domain boundary", async () => {
    const store = new PersistentDomainStateStore(
      new JSONPersistence(path.join(await mkdtemp(path.join(os.tmpdir(), "jarvis-agent-domain-")), "state.json")),
    );
    const workshop = new WorkshopEngine(store);

    assert.deepEqual(await workshop.handle("consume_item", { itemId: "i1", quantity: -1 }), {
      error: "Quantity must be positive",
    });
    assert.deepEqual(await workshop.handle("restock_item", { itemId: "i1", quantity: 0 }), {
      error: "Quantity must be positive",
    });
  });
});
