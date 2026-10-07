import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { withClientReferenceLock } from "../src/clients/clientReferenceLock.js";
import { InMemoryClientStore } from "../src/clients/inMemoryClientStore.js";
import { InMemoryEnquiryStore } from "../src/enquiries/inMemoryEnquiryStore.js";
import { InMemoryInvoiceStore } from "../src/invoices/inMemoryInvoiceStore.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import { InMemoryPropertyStore } from "../src/properties/inMemoryPropertyStore.js";
import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import { ClientController } from "../src/http/clientController.js";
import { EnquiryController } from "../src/http/enquiryController.js";
import { JarvisProblem } from "../src/http/problemDetails.js";

describe("client reference lock", () => {
  it("runs a later client-reference write only after the earlier one finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstFinished = false;
    const first = withClientReferenceLock(async () => {
      await gate;
      firstFinished = true;
    });
    let secondStarted = false;
    const second = withClientReferenceLock(async () => {
      secondStarted = true;
      assert.equal(firstFinished, true);
    });
    await delay(20);
    assert.equal(secondStarted, false);
    release();
    await first;
    await second;
  });

  it("does not let an enquiry land between the reference scan and client removal", async () => {
    const clients = new InMemoryClientStore();
    const enquiries = new InMemoryEnquiryStore();
    const client = await clients.add({ name: "Ada" });
    let releaseAfterScan: () => void = () => {};
    const afterScan = new Promise<void>((resolve) => {
      releaseAfterScan = resolve;
    });
    const list = enquiries.list.bind(enquiries);
    let scanned = false;
    enquiries.list = (filter) => {
      const rows = list(filter);
      return rows.then(async (found) => {
        scanned = true;
        await afterScan;
        return found;
      });
    };
    let added = 0;
    const add = enquiries.add.bind(enquiries);
    enquiries.add = (input) => {
      added += 1;
      return add(input);
    };
    const clientsHttp = new ClientController(
      clients,
      enquiries,
      new InMemoryInvoiceStore(),
      new InMemoryPropertyStore(),
      new InMemoryProjectStore(),
      new InMemoryQuoteStore(),
      null,
    );
    const enquiriesHttp = new EnquiryController(enquiries, new InMemoryProjectStore(), clients);

    const removal = clientsHttp.remove(client.id);
    for (let attempt = 0; attempt < 50 && !scanned; attempt += 1) await delay(5);
    assert.equal(scanned, true);
    const creating = enquiriesHttp.create({
      clientId: client.id,
      source: "phone",
      requestedWork: "Replace the tap",
    });
    await delay(30);
    assert.equal(added, 0);
    releaseAfterScan();
    const removed = await removal;
    assert.equal(removed.data.id, client.id);
    await assert.rejects(creating, (error: unknown) => {
      assert.ok(error instanceof JarvisProblem);
      assert.equal(error.getStatus(), 404);
      assert.equal(error.slug, "client-not-found");
      return true;
    });
    assert.equal(added, 0);
    assert.equal((await enquiries.list({ clientId: client.id })).length, 0);
    assert.equal(await clients.get(client.id), null);
  });

  it("refuses delete when the enquiry create already holds the lock", async () => {
    const clients = new InMemoryClientStore();
    const enquiries = new InMemoryEnquiryStore();
    const client = await clients.add({ name: "Ada" });
    let releaseAdd: () => void = () => {};
    const adding = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const add = enquiries.add.bind(enquiries);
    enquiries.add = async (input) => {
      await adding;
      return add(input);
    };
    const clientsHttp = new ClientController(
      clients,
      enquiries,
      new InMemoryInvoiceStore(),
      new InMemoryPropertyStore(),
      new InMemoryProjectStore(),
      new InMemoryQuoteStore(),
      null,
    );
    const enquiriesHttp = new EnquiryController(enquiries, new InMemoryProjectStore(), clients);

    const creating = enquiriesHttp.create({
      clientId: client.id,
      source: "phone",
      requestedWork: "Replace the tap",
    });
    await delay(20);
    const removal = clientsHttp.remove(client.id);
    releaseAdd();
    const created = await creating;
    assert.equal(created.data.clientId, client.id);
    await assert.rejects(removal, (error: unknown) => {
      assert.ok(error instanceof JarvisProblem);
      assert.equal(error.getStatus(), 409);
      assert.equal(error.slug, "client-still-referenced");
      return true;
    });
    assert.ok(await clients.get(client.id));
    assert.equal((await enquiries.list({ clientId: client.id })).length, 1);
  });
});
