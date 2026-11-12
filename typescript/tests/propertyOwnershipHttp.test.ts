import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { InMemoryEnquiryStore } from "../src/enquiries/inMemoryEnquiryStore.js";
import type { Enquiry } from "../src/enquiries/enquiry.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import type { Project } from "../src/projects/project.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "property-ownership-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in project HTTP tests");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const openApps: NestFastifyApplication[] = [];

type Stores = { projectStore?: InMemoryProjectStore; enquiryStore?: InMemoryEnquiryStore };

async function makeApp(stores: Stores = {}): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    ...stores,
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: InjectMethod,
  url: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return app.inject({
    method,
    url,
    headers: { ...(options.headers ?? {}) },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

type App = NestFastifyApplication;
type Problem = { type: string; status: number };

async function post<T>(app: App, url: string, payload: object, status = 201): Promise<T> {
  const response = await inject(app, "POST", url, { headers: AUTH, payload });
  assert.equal(response.statusCode, status, response.body);
  return response.json<{ data: T }>().data;
}

async function patch(app: App, url: string, payload: object) {
  return inject(app, "PATCH", url, { headers: AUTH, payload });
}

async function read<T>(app: App, url: string): Promise<T> {
  const response = await inject(app, "GET", url, { headers: AUTH });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ data: T }>().data;
}

function assertProblem(
  response: { statusCode: number; body: string; json: <T>() => T },
  status: number,
  slug: string,
): void {
  assert.equal(response.statusCode, status, response.body);
  assert.match(response.json<Problem>().type, new RegExp(`${slug}$`));
}

/** Two clients, each with one property. */
async function fixture(app: App) {
  const mine = (await post<{ id: string }>(app, "/api/v1/clients", { name: "Avery Holt" })).id;
  const other = (await post<{ id: string }>(app, "/api/v1/clients", { name: "Rowan Pike" })).id;
  const myProperty = (
    await post<{ id: string }>(app, "/api/v1/properties", {
      clientId: mine,
      address: "12 Wattle Road, Emerald",
    })
  ).id;
  const otherProperty = (
    await post<{ id: string }>(app, "/api/v1/properties", {
      clientId: other,
      address: "3 Banksia Court, Emerald",
    })
  ).id;
  return { mine, other, myProperty, otherProperty };
}

describe("property ownership at the project write boundary", () => {
  it("refuses a missing or foreign property on create and stores nothing", async () => {
    const app = await makeApp();
    const { mine, myProperty, otherProperty } = await fixture(app);
    assertProblem(
      await inject(app, "POST", "/api/v1/projects", {
        headers: AUTH,
        payload: { clientId: mine, propertyId: "no-such-property", title: "Hedge" },
      }),
      404,
      "property-not-found",
    );
    assertProblem(
      await inject(app, "POST", "/api/v1/projects", {
        headers: AUTH,
        payload: { clientId: mine, propertyId: otherProperty, title: "Hedge" },
      }),
      422,
      "property-client-mismatch",
    );
    assert.deepEqual(await read<Project[]>(app, "/api/v1/projects"), []);
    const created = await post<Project>(app, "/api/v1/projects", {
      clientId: mine,
      propertyId: myProperty,
      title: "Hedge",
    });
    assert.equal(created.propertyId, myProperty);
  });

  it("refuses a missing or foreign property on update and keeps the stored link", async () => {
    const app = await makeApp();
    const { mine, myProperty, otherProperty } = await fixture(app);
    const project = await post<Project>(app, "/api/v1/projects", {
      clientId: mine,
      propertyId: myProperty,
      title: "Hedge",
    });
    const url = `/api/v1/projects/${project.id}`;
    assertProblem(await patch(app, url, { propertyId: "no-such" }), 404, "property-not-found");
    assertProblem(
      await patch(app, url, { propertyId: otherProperty, notes: "moved" }),
      422,
      "property-client-mismatch",
    );
    const stored = await read<Project>(app, url);
    assert.equal(stored.propertyId, myProperty);
    assert.equal(stored.notes, undefined, "a refused update writes nothing");
  });

  it("refuses a client change that would strand the property, and allows consistent moves", async () => {
    const app = await makeApp();
    const { mine, other, myProperty, otherProperty } = await fixture(app);
    const project = await post<Project>(app, "/api/v1/projects", {
      clientId: mine,
      propertyId: myProperty,
      title: "Hedge",
    });
    const url = `/api/v1/projects/${project.id}`;
    assertProblem(await patch(app, url, { clientId: other }), 422, "property-client-mismatch");
    assertProblem(
      await patch(app, url, { clientId: other, propertyId: myProperty }),
      422,
      "property-client-mismatch",
    );
    assert.equal((await read<Project>(app, url)).clientId, mine);

    // Moving the client together with a property it owns is consistent.
    const moved = await patch(app, url, { clientId: other, propertyId: otherProperty });
    assert.equal(moved.statusCode, 200, moved.body);
    // Detach, then a client change has nothing to strand; reattach is checked.
    assert.equal((await patch(app, url, { propertyId: null })).statusCode, 200);
    assert.equal((await patch(app, url, { clientId: mine })).statusCode, 200);
    assertProblem(
      await patch(app, url, { propertyId: otherProperty }),
      422,
      "property-client-mismatch",
    );
    assert.equal((await patch(app, url, { propertyId: myProperty })).statusCode, 200);
    const stored = await read<Project>(app, url);
    assert.deepEqual([stored.clientId, stored.propertyId], [mine, myProperty]);
  });

  it("keeps a historical mismatched job readable, editable and detachable", async () => {
    const projectStore = new InMemoryProjectStore();
    const app = await makeApp({ projectStore });
    const { mine, otherProperty } = await fixture(app);
    const legacy = await projectStore.add({
      clientId: mine,
      propertyId: otherProperty,
      title: "Legacy job",
    });
    const url = `/api/v1/projects/${legacy.id}`;
    assert.equal((await read<Project>(app, url)).propertyId, otherProperty);
    assert.equal((await patch(app, url, { notes: "reviewed" })).statusCode, 200);
    assert.equal((await read<Project>(app, url)).propertyId, otherProperty, "not reassociated");
    assert.equal((await patch(app, url, { propertyId: null })).statusCode, 200);
    assert.equal((await read<Project>(app, url)).propertyId, undefined);
  });
});

describe("property ownership at the enquiry write boundary", () => {
  const intake = { source: "phone", requestedWork: "Prune trees near fence" };

  it("refuses a missing or foreign property on create and update", async () => {
    const app = await makeApp();
    const { mine, myProperty, otherProperty } = await fixture(app);
    for (const [propertyId, status, slug] of [
      ["no-such-property", 404, "property-not-found"],
      [otherProperty, 422, "property-client-mismatch"],
    ] as const) {
      assertProblem(
        await inject(app, "POST", "/api/v1/enquiries", {
          headers: AUTH,
          payload: { ...intake, clientId: mine, propertyId },
        }),
        status,
        slug,
      );
    }
    assert.deepEqual(await read<Enquiry[]>(app, "/api/v1/enquiries"), []);

    const enquiry = await post<Enquiry>(app, "/api/v1/enquiries", { ...intake, clientId: mine });
    const url = `/api/v1/enquiries/${enquiry.id}`;
    assertProblem(await patch(app, url, { propertyId: "no-such" }), 404, "property-not-found");
    assertProblem(
      await patch(app, url, { propertyId: otherProperty }),
      422,
      "property-client-mismatch",
    );
    assert.equal((await read<Enquiry>(app, url)).propertyId, undefined);
    assert.equal((await patch(app, url, { propertyId: myProperty })).statusCode, 200);
    assert.equal((await patch(app, url, { propertyId: null })).statusCode, 200);
    assert.equal((await read<Enquiry>(app, url)).propertyId, undefined);
  });

  it("does not convert a historical enquiry whose property is foreign or missing", async () => {
    const enquiryStore = new InMemoryEnquiryStore();
    const app = await makeApp({ enquiryStore });
    const { mine, myProperty, otherProperty } = await fixture(app);
    for (const propertyId of [otherProperty, "no-such-property"]) {
      const legacy = await enquiryStore.add({ ...intake, clientId: mine, propertyId });
      const response = await inject(app, "POST", `/api/v1/enquiries/${legacy.id}/convert-project`, {
        headers: AUTH,
        payload: {},
      });
      assert.ok([404, 422].includes(response.statusCode), response.body);
      assert.match(response.json<Problem>().type, /property-(not-found|client-mismatch)$/);
      assert.equal((await read<Enquiry>(app, `/api/v1/enquiries/${legacy.id}`)).status, "open");
    }
    assert.deepEqual(await read<Project[]>(app, "/api/v1/projects"), []);

    const good = await post<Enquiry>(app, "/api/v1/enquiries", {
      ...intake,
      clientId: mine,
      propertyId: myProperty,
    });
    const url = `/api/v1/enquiries/${good.id}/convert-project`;
    const converted = await post<{ project: Project }>(app, url, {});
    assert.equal(converted.project.propertyId, myProperty);
    // The property is now pinned, and a replay still returns the first job.
    const replay = await post<{ replayed: boolean }>(app, url, {});
    assert.equal(replay.replayed, true);
  });
});

describe("a referenced property cannot be moved or deleted", () => {
  it("refuses a client change or delete while a job or enquiry points at it", async () => {
    const app = await makeApp();
    const { mine, other, myProperty } = await fixture(app);
    const propertyUrl = `/api/v1/properties/${myProperty}`;
    const project = await post<Project>(app, "/api/v1/projects", {
      clientId: mine,
      propertyId: myProperty,
      title: "Hedge",
    });
    assertProblem(
      await patch(app, propertyUrl, { clientId: other }),
      409,
      "property-still-referenced",
    );
    assertProblem(
      await inject(app, "DELETE", propertyUrl, { headers: AUTH }),
      409,
      "property-still-referenced",
    );
    // Same-client and non-client updates are unaffected.
    assert.equal((await patch(app, propertyUrl, { clientId: mine })).statusCode, 200);
    assert.equal((await patch(app, propertyUrl, { accessNotes: "Side gate" })).statusCode, 200);

    assert.equal(
      (await patch(app, `/api/v1/projects/${project.id}`, { propertyId: null })).statusCode,
      200,
    );
    const enquiry = await post<Enquiry>(app, "/api/v1/enquiries", {
      source: "phone",
      requestedWork: "Prune",
      clientId: mine,
      propertyId: myProperty,
    });
    assertProblem(
      await inject(app, "DELETE", propertyUrl, { headers: AUTH }),
      409,
      "property-still-referenced",
    );
    assert.equal(
      (await patch(app, `/api/v1/enquiries/${enquiry.id}`, { propertyId: null })).statusCode,
      200,
    );
    assert.equal((await patch(app, propertyUrl, { clientId: other })).statusCode, 200);
    assert.equal((await inject(app, "DELETE", propertyUrl, { headers: AUTH })).statusCode, 200);
  });

  it("returns 404, not 409, for an absent property that historical records still name", async () => {
    const projectStore = new InMemoryProjectStore();
    const enquiryStore = new InMemoryEnquiryStore();
    const app = await makeApp({ projectStore, enquiryStore });
    const { mine } = await fixture(app);
    await projectStore.add({ clientId: mine, propertyId: "gone-property", title: "Legacy job" });
    await enquiryStore.add({
      clientId: mine,
      propertyId: "gone-property",
      source: "phone",
      requestedWork: "Prune",
    });
    assertProblem(
      await inject(app, "DELETE", "/api/v1/properties/gone-property", { headers: AUTH }),
      404,
      "property-not-found",
    );
    assertProblem(
      await patch(app, "/api/v1/properties/gone-property", { clientId: mine }),
      404,
      "property-not-found",
    );
  });

  it("serialises a property delete against a job create that references it", async () => {
    const app = await makeApp();
    const { mine, myProperty } = await fixture(app);
    const [created, removed] = await Promise.all([
      inject(app, "POST", "/api/v1/projects", {
        headers: AUTH,
        payload: { clientId: mine, propertyId: myProperty, title: "Hedge" },
      }),
      inject(app, "DELETE", `/api/v1/properties/${myProperty}`, { headers: AUTH }),
    ]);
    const outcomes = [created.statusCode, removed.statusCode];
    assert.ok(
      (outcomes[0] === 201 && outcomes[1] === 409) || (outcomes[0] === 404 && outcomes[1] === 200),
      `one of the two writes must lose: ${outcomes.join(", ")}`,
    );
  });
});
