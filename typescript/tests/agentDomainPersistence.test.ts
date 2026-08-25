import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { BusinessEngine } from "../src/agent/businessEngine.js";
import { AGENT_DOMAIN_STATE_KEY, PersistentDomainStateStore } from "../src/agent/domainState.js";
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
        {
          name: "workshop_focus",
          description: "Workshop lights, music, tools ready",
        },
      ]);

      const state = await persistence.loadState();
      const domainState = state[AGENT_DOMAIN_STATE_KEY] as {
        version: number;
        home: { activeScene?: string };
      };
      assert.equal(domainState.version, 1);
      assert.equal(domainState.home.activeScene, "arrival");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires durable evidence before a business job can complete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-agent-domain-"));

    try {
      const persistence = new JSONPersistence(path.join(directory, "state.json"));
      const business = new BusinessEngine(new PersistentDomainStateStore(persistence));

      await business.handle("add_client", { name: "Kirsten" });
      await business.handle("create_job", {
        clientId: "c2",
        description: "Remove green waste",
      });

      assert.deepEqual(await business.handle("complete_job", { jobId: "j3" }), {
        error: "Job completion requires at least one evidence reference",
      });
      assert.deepEqual(await business.handle("schedule_job", { jobId: "j3" }), {
        id: "j3",
        clientId: "c2",
        description: "Remove green waste",
        status: "scheduled",
      });
      assert.deepEqual(
        await business.handle("complete_job", { jobId: "j3", completionEvidenceRefs: ["photo-1"] }),
        {
          error: "Job cannot transition from scheduled to completed",
        },
      );
      assert.deepEqual(await business.handle("start_job", { jobId: "j3" }), {
        id: "j3",
        clientId: "c2",
        description: "Remove green waste",
        status: "in_progress",
      });

      const completed = await business.handle("complete_job", {
        jobId: "j3",
        completionEvidenceRefs: ["photo-1", " photo-1 ", "receipt-1"],
      });
      assert.equal(typeof completed, "object");
      assert.notEqual(completed, null);
      assert.deepEqual(
        {
          ...(completed as Record<string, unknown>),
          completedAt: "dynamic",
        },
        {
          id: "j3",
          clientId: "c2",
          description: "Remove green waste",
          status: "completed",
          completionEvidenceRefs: ["photo-1", "receipt-1"],
          completedAt: "dynamic",
        },
      );

      const restored = new BusinessEngine(new PersistentDomainStateStore(persistence));
      const jobs = await restored.handle("list_jobs", {});
      assert.deepEqual(
        (jobs as Array<Record<string, unknown>>).map((job) => ({
          ...job,
          completedAt: "dynamic",
        })),
        [
          {
            id: "j3",
            clientId: "c2",
            description: "Remove green waste",
            status: "completed",
            completionEvidenceRefs: ["photo-1", "receipt-1"],
            completedAt: "dynamic",
          },
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe inventory mutations at the domain boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-agent-domain-"));

    try {
      const persistence = new JSONPersistence(path.join(directory, "state.json"));
      const workshop = new WorkshopEngine(new PersistentDomainStateStore(persistence));

      assert.deepEqual(await workshop.handle("consume_item", { itemId: "i1", quantity: -1 }), {
        error: "Quantity must be positive",
      });
      assert.deepEqual(await workshop.handle("restock_item", { itemId: "i1", quantity: 0 }), {
        error: "Quantity must be positive",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
