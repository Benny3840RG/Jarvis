import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";

test("invalid scheduled date leaves the whole in-memory project unchanged", async () => {
  const store = new InMemoryProjectStore();
  const project = await store.add({ clientId: "client-1", title: "Original job" });
  await assert.rejects(
    store.update(project.id, { title: "Must not stick", scheduledFor: "2026-02-30" }),
    /Project scheduledFor/,
  );
  assert.deepEqual(await store.get(project.id), project);
});

test("in-memory scheduled dates can be set, preserved, rescheduled and cleared", async () => {
  const store = new InMemoryProjectStore();
  const project = await store.add({
    clientId: "client-1",
    title: "Booked job",
    scheduledFor: "2026-10-06",
  });
  assert.equal(project.scheduledFor, "2026-10-06");
  assert.equal(
    (await store.update(project.id, { title: "Renamed job" }))?.scheduledFor,
    "2026-10-06",
  );
  const moved = await store.update(project.id, { scheduledFor: "2026-10-09" });
  assert.equal(moved?.scheduledFor, "2026-10-09");
  const cleared = await store.update(project.id, { scheduledFor: null });
  assert.equal(cleared?.scheduledFor, undefined);
  assert.equal((await store.get(project.id))?.scheduledFor, undefined);
});
