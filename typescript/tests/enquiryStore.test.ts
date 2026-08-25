import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryEnquiryStore } from "../src/enquiries/inMemoryEnquiryStore.js";
import { JsonEnquiryStore } from "../src/enquiries/jsonEnquiryStore.js";
import type { EnquiryStore } from "../src/enquiries/enquiry.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";

let dir: string;

function stores(): { name: string; make: () => EnquiryStore }[] {
  return [
    {
      name: "JsonEnquiryStore",
      make: () => new JsonEnquiryStore(path.join(dir, "enquiries.json")),
    },
    { name: "InMemoryEnquiryStore", make: () => new InMemoryEnquiryStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-enquiries-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("adds an open enquiry and replays a duplicate key without creating a second row", async () => {
      const store = make();
      const created = await store.add({
        clientId: "c1",
        propertyId: "p1",
        source: "phone",
        requestedWork: "Trim hedge",
        urgency: "urgent",
        attachmentRefs: [" photo-1 ", "photo-1"],
        duplicateKey: "call-123",
      });
      const replay = await store.add({
        clientId: "c1",
        source: "email",
        requestedWork: "Different",
        duplicateKey: "call-123",
      });
      assert.equal(replay.id, created.id);
      assert.equal((await store.list()).length, 1);
      assert.deepEqual(created.attachmentRefs, ["photo-1"]);
    });

    it("filters, updates and closes only open enquiries", async () => {
      const store = make();
      const enquiry = await store.add({ clientId: "c1", source: "web", requestedWork: "Mow lawn" });
      await store.add({ clientId: "c2", source: "phone", requestedWork: "Fence repair" });
      assert.equal((await store.list({ clientId: "c1" })).length, 1);
      const updated = await store.update(enquiry.id, {
        propertyId: "p1",
        preferredDateText: "next Friday",
        safetyNotes: "Steep driveway",
      });
      assert.equal(updated?.propertyId, "p1");
      assert.equal(updated?.safetyNotes, "Steep driveway");
      const closed = await store.close(enquiry.id, "Client went elsewhere");
      assert.equal(closed?.status, "closed");
      await assert.rejects(
        () => store.update(enquiry.id, { source: "phone" }),
        /Only open enquiries can be updated/,
      );
    });

    it("converts once into the existing project authority and replays the same conversion", async () => {
      const store = make();
      const projects = new InMemoryProjectStore();
      const enquiry = await store.add({
        clientId: "c1",
        propertyId: "p1",
        source: "referral",
        requestedWork: "Replace side gate",
        safetyNotes: "Dog on site",
      });
      const converted = await store.convertToProject(enquiry.id, projects);
      assert.equal(converted?.replayed, false);
      assert.equal(converted?.project.clientId, "c1");
      assert.equal(converted?.project.propertyId, "p1");
      assert.equal(converted?.project.title, "Replace side gate");
      assert.match(converted?.project.notes ?? "", /Converted from enquiry/);
      const replay = await store.convertToProject(enquiry.id, projects, { title: "Other" });
      assert.equal(replay?.replayed, true);
      assert.equal(replay?.project.id, converted?.project.id);
      assert.equal((await projects.list()).length, 1);
    });

    it("rejects blank required fields and conversion from closed enquiries", async () => {
      const store = make();
      await assert.rejects(
        () => store.add({ clientId: " ", source: "phone", requestedWork: "X" }),
        /clientId cannot be empty/,
      );
      const enquiry = await store.add({ clientId: "c1", source: "phone", requestedWork: "X" });
      await store.close(enquiry.id, "No response");
      await assert.rejects(
        () => store.convertToProject(enquiry.id, new InMemoryProjectStore()),
        /Only open enquiries can be converted/,
      );
    });
  });
}

describe("JsonEnquiryStore durability", () => {
  it("reads back an enquiry through a fresh instance", async () => {
    const file = path.join(dir, "enquiries.json");
    const first = new JsonEnquiryStore(file);
    const added = await first.add({ clientId: "c1", source: "web", requestedWork: "Garden tidy" });
    const reopened = new JsonEnquiryStore(file);
    assert.equal((await reopened.get(added.id))?.requestedWork, "Garden tidy");
  });

  it("rolls back a newly created project when persisting the conversion fails", async () => {
    const file = path.join(dir, "enquiries.json");
    const store = new JsonEnquiryStore(file);
    const projects = new InMemoryProjectStore();
    const enquiry = await store.add({
      clientId: "c1",
      source: "phone",
      requestedWork: "Repair side gate",
    });
    const internals = store as unknown as {
      writeDocument(document: unknown): Promise<void>;
    };
    internals.writeDocument = async () => {
      throw new Error("simulated enquiry persistence failure");
    };

    await assert.rejects(
      () => store.convertToProject(enquiry.id, projects),
      /simulated enquiry persistence failure/,
    );
    assert.equal((await projects.list()).length, 0);

    const reopened = new JsonEnquiryStore(file);
    const persisted = await reopened.get(enquiry.id);
    assert.equal(persisted?.status, "open");
    assert.equal(persisted?.convertedProjectId, undefined);

    const converted = await reopened.convertToProject(enquiry.id, projects);
    assert.equal(converted?.replayed, false);
    assert.equal((await projects.list()).length, 1);
  });
});
