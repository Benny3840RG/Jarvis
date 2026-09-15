import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import { JsonAssetStore } from "../src/assets/jsonAssetStore.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { JsonBusinessSettingsStore } from "../src/businessSettings/jsonBusinessSettingsStore.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JsonEnquiryStore } from "../src/enquiries/jsonEnquiryStore.js";
import { JsonErrandStore } from "../src/errands/jsonErrandStore.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import { JsonPreferenceStore } from "../src/preferences/jsonPreferenceStore.js";
import { JsonProjectStore } from "../src/projects/jsonProjectStore.js";
import { JsonPropertyStore } from "../src/properties/jsonPropertyStore.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";
import { writePrivateJsonFile } from "../src/persistence/atomicJsonFile.js";
import { JsonFileLock } from "../src/persistence/jsonFileLock.js";

const stores = [
  JsonAssetStore,
  JsonBuildLogStore,
  JsonBuildStore,
  JsonClientStore,
  JsonEnquiryStore,
  JsonErrandStore,
  JsonInvoiceStore,
  JsonPreferenceStore,
  JsonProjectStore,
  JsonPropertyStore,
  JsonQuoteStore,
  JsonUpgradeStore,
];

const readers: { name: string; read: (file: string) => Promise<unknown> }[] = stores.flatMap(
  (Store) => [
    { name: `${Store.name}.list`, read: (file: string) => new Store(file).list() },
    { name: `${Store.name}.get`, read: (file: string) => new Store(file).get("record-1") },
  ],
);
readers.push({
  name: "JsonBusinessSettingsStore.get",
  read: (file: string) => new JsonBusinessSettingsStore(file).get(),
});

for (const reader of readers) {
  it(`${reader.name} preserves a replacement published after its corrupt read`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-store-recovery-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "records.json");
    await fs.writeFile(file, "{");
    const readFile = fs.readFile.bind(fs);
    let intercept = true;
    const replacement = { version: 1 };
    let published = "";
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const raw = await readFile(...args);
      if (args[0] === file && intercept) {
        intercept = false;
        // Use the same lock and atomic publisher as a separate store writer.
        // Its successful replacement must survive the delayed reader.
        await new JsonFileLock(file, () => undefined, 40).run(async () => {
          await writePrivateJsonFile(file, replacement);
          published = await readFile(file, "utf8");
        });
      }
      return raw;
    });

    await reader.read(file);
    assert.equal(await readFile(file, "utf8"), published);
    assert.deepEqual(await fs.readdir(dir), ["records.json"]);
  });
}
