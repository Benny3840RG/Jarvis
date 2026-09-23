import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { exportBackup, verifyBackupRestore } from "../src/backup/backup.js";
import {
  CROSS_DOMAIN_REFERENCE_FIELDS,
  remapCrossDomainReferences,
} from "../src/backup/crossDomainReferences.js";
import { UuidRemapper } from "../src/backup/uuidRemapper.js";
import { InMemoryAssetStore } from "../src/assets/inMemoryAssetStore.js";
import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { InMemoryBuildStore } from "../src/builds/inMemoryBuildStore.js";
import { InMemoryPreferenceStore } from "../src/preferences/inMemoryPreferenceStore.js";
import { JSONPersistence } from "../src/persistence/persistence.js";
import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";

function sequence(prefix = "new"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

describe("UuidRemapper", () => {
  it("returns the same new id for every lookup of one old id", () => {
    const remapper = new UuidRemapper({ createId: sequence() });

    assert.equal(remapper.remap("old-a"), "new-1");
    assert.equal(remapper.remap("old-a"), "new-1");
    assert.equal(remapper.remap("old-b"), "new-2");
    assert.equal(remapper.remap("old-a"), "new-1");
    assert.equal(remapper.size, 2);
  });

  it("keeps a store-assigned id without minting another", () => {
    let calls = 0;
    const remapper = new UuidRemapper({
      createId: () => {
        calls += 1;
        return "minted";
      },
    });

    remapper.bind("build-1", "store-build");
    assert.equal(remapper.remap("build-1"), "store-build");
    assert.equal(remapper.lookup("build-1"), "store-build");
    assert.equal(calls, 0);
    remapper.bind("build-1", "store-build");
    assert.throws(() => remapper.bind("build-1", "other"), /already mapped/);
    assert.throws(() => remapper.bind("build-2", "store-build"), /already assigned/);
  });

  it("rejects an empty id and a createId that cannot mint a free id", () => {
    const remapper = new UuidRemapper({ createId: () => "fixed" });
    assert.throws(() => remapper.remap(""), /non-empty/);
    assert.equal(remapper.remap("a"), "fixed");
    assert.throws(() => remapper.remap("b"), /unused id/);
  });

  it("remaps listed foreign keys, including a nested record, and leaves other fields", () => {
    const remapper = new UuidRemapper({ createId: sequence() });
    const clientId = remapper.remap("client-1");
    const input = {
      id: "project-1",
      clientId: "client-1",
      title: "Deck",
      notes: "client-1",
      detail: { clientId: "client-1", label: "site" },
    };

    const remapped = remapper.remapFields(input, ["clientId"]);

    assert.notEqual(remapped, input);
    assert.equal(input.clientId, "client-1");
    assert.equal(remapped.clientId, clientId);
    assert.equal(remapped.id, "project-1");
    assert.equal(remapped.title, "Deck");
    assert.equal(remapped.notes, "client-1");
    assert.deepEqual(remapped.detail, { clientId: "client-1", label: "site" });

    const detail = remapper.remapFields(remapped.detail, ["clientId"]);
    assert.equal(detail.clientId, clientId);
    assert.equal(detail.label, "site");
    assert.deepEqual(remapper.remapArray(["client-1", "client-2", "client-1"]), [
      clientId,
      "new-2",
      clientId,
    ]);
  });

  it("remaps an array field and leaves an unlisted array alone", () => {
    const remapper = new UuidRemapper({ createId: sequence() });
    const record = {
      relatedIds: ["a", "b", "a"],
      attachmentRefs: ["a"],
      notes: "a",
    };

    const remapped = remapper.remapArrayFields(record, ["relatedIds"]);

    assert.deepEqual(remapped.relatedIds, ["new-1", "new-2", "new-1"]);
    assert.deepEqual(remapped.attachmentRefs, ["a"]);
    assert.equal(remapped.notes, "a");
    assert.deepEqual(record.relatedIds, ["a", "b", "a"]);
    assert.throws(
      () => remapper.remapArrayFields({ relatedIds: "a" }, ["relatedIds"]),
      /expected an array of ids/,
    );
  });

  it("translates only strings already in the map, one pass, without minting", () => {
    let calls = 0;
    const remapper = new UuidRemapper({
      createId: () => {
        calls += 1;
        return "minted";
      },
    });
    remapper.bind("task-1", "task-new");
    remapper.bind("task-new", "task-newer");

    assert.deepEqual(
      remapper.translateKnown({
        note: "leave me",
        count: 1,
        lastTask: { id: "task-1", title: "task-1" },
        ids: ["task-1", "other"],
      }),
      {
        note: "leave me",
        count: 1,
        lastTask: { id: "task-new", title: "task-new" },
        ids: ["task-new", "other"],
      },
    );
    assert.equal(remapper.translateKnown("task-new"), "task-newer");
    assert.equal(calls, 0);
    assert.equal(remapper.size, 2);
  });
});

describe("cross-domain reference scaffold", () => {
  it("lists the business foreign keys and does not claim notesAndEvidence", () => {
    assert.deepEqual(Object.keys(CROSS_DOMAIN_REFERENCE_FIELDS), [
      "properties",
      "projects",
      "quotes",
      "invoices",
      "enquiries",
      "errands",
    ]);
    assert.equal("notesAndEvidence" in CROSS_DOMAIN_REFERENCE_FIELDS, false);
    assert.deepEqual(CROSS_DOMAIN_REFERENCE_FIELDS.invoices, ["clientId", "projectId", "quoteId"]);
  });

  it("remaps quote and invoice foreign keys through one map and leaves other fields", () => {
    const remapper = new UuidRemapper({ createId: sequence("id") });
    const clientId = remapper.remap("client-1");
    const projectId = remapper.remap("project-1");
    const quoteId = remapper.remap("quote-1");

    const quote = remapCrossDomainReferences(remapper, "quotes", {
      id: "quote-1",
      clientId: "client-1",
      projectId: "project-1",
      number: "Q-100",
      notes: "client-1",
      lineItems: [{ description: "Boards", quantity: 2, unitPrice: 10 }],
    });
    const invoice = remapCrossDomainReferences(remapper, "invoices", {
      id: "invoice-1",
      clientId: "client-1",
      projectId: "project-1",
      quoteId: "quote-1",
      number: "I-100",
      payments: [{ id: "pay-1", amount: 10 }],
    });
    const enquiry = remapCrossDomainReferences(remapper, "enquiries", {
      id: "enquiry-1",
      clientId: "client-1",
      attachmentRefs: ["blob-a"],
      convertedProjectId: "project-1",
    });

    assert.equal(quote.id, "quote-1");
    assert.equal(quote.clientId, clientId);
    assert.equal(quote.projectId, projectId);
    assert.equal(quote.number, "Q-100");
    assert.equal(quote.notes, "client-1");
    assert.deepEqual(quote.lineItems, [{ description: "Boards", quantity: 2, unitPrice: 10 }]);
    assert.equal(invoice.quoteId, quoteId);
    assert.equal(invoice.clientId, clientId);
    assert.deepEqual(invoice.payments, [{ id: "pay-1", amount: 10 }]);
    assert.equal(enquiry.convertedProjectId, projectId);
    assert.deepEqual(enquiry.attachmentRefs, ["blob-a"]);
  });
});

describe("backup restore uses UuidRemapper", () => {
  it("restores nested assistant-state ids and leaves unrelated text", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-uuid-remap-"));
    try {
      const source = new JSONPersistence(path.join(directory, "source.json"));
      const task = await source.addTask("Measure gate", "work");
      const shared = task.id;
      await source.saveState({
        label: "not-an-id",
        nested: { taskId: shared, note: "keep" },
      });
      const archive = await exportBackup(source, () => new Date("2026-07-13T03:30:00.000Z"), {
        builds: new InMemoryBuildStore(),
        buildLogs: new InMemoryBuildLogStore(),
        upgrades: new InMemoryUpgradeStore(),
        assets: new InMemoryAssetStore(),
        preferences: new InMemoryPreferenceStore(),
      });

      const verified = await verifyBackupRestore(archive);
      assert.equal(verified.taskCount, 1);
      assert.notEqual(verified.taskIds.get(shared), shared);

      const collision = new JSONPersistence(path.join(directory, "collision.json"));
      const restored = await collision.restoreSnapshotIntoEmpty({
        state: { nested: { id: shared, note: "keep" } },
        tasks: [
          {
            id: shared,
            title: "Task",
            completed: false,
            category: "work",
            createdAt: 1,
          },
        ],
        reminders: [{ id: shared, title: "Reminder", createdAt: 1 }],
      });
      const taskId = restored.taskIds.get(shared);
      const reminderId = restored.reminderIds.get(shared);
      const nested = restored.snapshot.state.nested as { id: string; note: string };
      assert.notEqual(taskId, reminderId);
      assert.equal(nested.id, reminderId);
      assert.equal(nested.note, "keep");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
