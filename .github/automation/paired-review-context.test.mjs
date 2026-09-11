import test from "node:test";
import assert from "node:assert/strict";
import { pairedUnits } from "./paired-review-context.mjs";

test("pairs semantic OpenAPI entries without dropping formatting or splitting objects", () => {
  const before = JSON.stringify(
    {
      openapi: "3.1.0",
      paths: {
        "/a": { get: { description: "é".repeat(40000) } },
        "/b": { get: {} },
      },
      components: { schemas: { Thing: { type: "string" } } },
    },
    null,
    2,
  );
  const after = before.replace('"type": "string"', '"type": "number"');
  const units = pairedUnits([{ filename: "api.json", before, after }]);
  for (const side of ["before", "after"]) {
    const ranges = units
      .flatMap((u) =>
        u.parts.flatMap((p) =>
          p.references
            .filter((r) => r.side === side)
            .map((r) => ({ ...r, text: p.text })),
        ),
      )
      .sort((a, b) => a.start - b.start);
    assert.equal(ranges[0].start, 0);
    for (let i = 1; i < ranges.length; i++)
      assert.equal(ranges[i - 1].end, ranges[i].start);
    assert.equal(
      ranges.map((r) => r.text).join(""),
      side === "before" ? before : after,
    );
  }
  const path = units.find((u) => u.label === "/paths/~1a");
  assert.ok(path);
  assert.ok(path.parts[0].text.includes('"get"'));
  assert.equal(path.parts[0].references.length, 2);
  const schema = units.find((u) => u.label === "/components/schemas/Thing");
  assert.equal(schema.parts.length, 2);
});

test("pairs whole files and deduplicates identical source with both exact references", () => {
  const units = pairedUnits([
    { filename: "a.ts", before: "const x=1;\n", after: "const x=1;\n" },
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].parts.length, 1);
  assert.deepEqual(
    units[0].parts[0].references.map((r) => r.side),
    ["before", "after"],
  );
});

test("added and removed files retain their one-sided coverage", () => {
  const units = pairedUnits([
    { filename: "new.ts", before: null, after: "é" },
    { filename: "old.ts", before: "old", after: null },
  ]);
  assert.deepEqual(
    units.flatMap((u) =>
      u.parts.flatMap((p) => p.references.map((r) => r.side)),
    ),
    ["after", "before"],
  );
});

test("changed import context only resolves already-fetched direct relative modules", async () => {
  const { changedImportContext } = await import("./paired-review-context.mjs");
  const files = [
    {
      filename: "src/a.ts",
      before: null,
      after:
        'import {schema} from "./schema.js"; import x from "external"; import y from "./absent.js";',
    },
    {
      filename: "src/schema.ts",
      before: null,
      after: 'export const schema = "literal";',
    },
  ];
  assert.deepEqual(changedImportContext(files, new Set([0])), [1]);
});

test("large source preserves paired unchanged runs between separate small edits", () => {
  const before = Array.from(
    { length: 12000 },
    (_, i) => `const value${i} = ${i};\n`,
  ).join("");
  const after = before
    .replace("value300 = 300", "value300 = 301")
    .replace("value11000 = 11000", "value11000 = 11001");
  const units = pairedUnits([{ filename: "server.ts", before, after }]);
  const changed = units.filter((u) =>
    u.parts.some((p) => p.references.length === 1),
  );
  assert.ok(
    changed.reduce(
      (n, u) => n + u.parts.reduce((m, p) => m + Buffer.byteLength(p.text), 0),
      0,
    ) < 1000,
  );
});

test("related changed wiring includes reverse importer and controller sharing the contract", async () => {
  const { relatedChangedContext, supplementalUnits } =
    await import("./paired-review-context.mjs");
  const files = [
    {
      filename: "src/client.ts",
      before: null,
      after: 'import {Contract} from "./contract.js";',
    },
    {
      filename: "src/contract.ts",
      before: null,
      after: "export type Contract = string;",
    },
    {
      filename: "src/server.ts",
      before: null,
      after: 'import {client} from "./client.js";',
    },
    {
      filename: "src/controller.ts",
      before: null,
      after: 'import {Contract} from "./contract.js";',
    },
  ];
  assert.deepEqual(relatedChangedContext(files, new Set([0])), [0, 1, 2, 3]);
  for (const ref of supplementalUnits(files, 3))
    assert.equal(
      Buffer.from(files[3][ref.side]).subarray(ref.start, ref.end).toString(),
      ref.text,
    );
});

test("same-file JSON references supply later schemas and terminate cycles", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  const source = JSON.stringify(
    {
      paths: { "/a": { get: { $ref: "#/components/schemas/A" } } },
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A", type: "object" },
        },
      },
    },
    null,
    2,
  );
  const units = [
    {
      label: "endpoint",
      parts: [
        {
          text: '"$ref":"#/components/schemas/A"',
          references: [
            { fileIndex: 0, side: "after", start: 0, end: 0, lineStart: 1 },
          ],
        },
      ],
    },
  ];
  const result = jsonReferenceContext(
    [{ filename: "api.json", before: null, after: source }],
    units,
  );
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.contexts.length, 2);
  assert.ok(result.contexts.some((c) => c.pointer.endsWith("/B")));
  for (const context of result.contexts)
    for (const ref of context.parts)
      assert.equal(
        Buffer.from(source).subarray(ref.start, ref.end).toString(),
        ref.text,
      );
});

test("local reference closure reports missing targets and bounded traversal overflow", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  const schemas = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => ["S" + i, { type: "string" }]),
  );
  const source = JSON.stringify({ components: { schemas } });
  const text = JSON.stringify(
    Array.from({ length: 129 }, (_, i) => ({
      $ref: "#/components/schemas/S" + i,
    })),
  );
  const unit = (text) => [
    {
      label: "refs",
      parts: [
        {
          text,
          references: [
            { fileIndex: 0, side: "after", start: 0, end: 0, lineStart: 1 },
          ],
        },
      ],
    },
  ];
  const files = [{ filename: "api.json", before: null, after: source }];
  const result = jsonReferenceContext(files, unit(text));
  assert.equal(result.contexts.length, 128);
  assert.ok(result.unresolved.some((item) => item.reason.includes("128")));
  const missing = jsonReferenceContext(
    files,
    unit('{"$ref":"#/components/schemas/missing"}'),
  );
  assert.equal(missing.contexts.length, 0);
  assert.equal(missing.unresolved.length, 1);
});

test("JSON reference context validates nested pointers and binds both identical sides", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  const source = JSON.stringify({
    components: {
      schemas: { "A/B~C": { properties: { value: { type: "string" } } } },
    },
  });
  const files = [{ filename: "api.json", before: source, after: source }];
  const units = (ref) => [
    {
      label: "refs",
      parts: [
        {
          text: JSON.stringify({ $ref: ref }),
          references: [
            { fileIndex: 0, side: "before", start: 0, end: 0, lineStart: 1 },
            { fileIndex: 0, side: "after", start: 0, end: 0, lineStart: 1 },
          ],
        },
      ],
    },
  ];
  const result = jsonReferenceContext(
    files,
    units("#/components/schemas/A~1B~0C/properties/value"),
  );
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.contexts.length, 1);
  const part = result.contexts[0].parts[0];
  assert.equal(part.otherSides.length, 1);
  assert.equal(part.otherSides[0].side, "after");
  assert.equal(
    Buffer.from(source)
      .subarray(part.otherSides[0].start, part.otherSides[0].end)
      .toString(),
    part.text,
  );
  for (const ref of [
    "#not-a-pointer",
    "#/%zz",
    "#/components/schemas/A~1B~0C/missing",
    "#/components/schemas/A~2",
  ]) {
    const invalid = jsonReferenceContext(files, units(ref));
    assert.equal(invalid.contexts.length, 0);
    assert.ok(invalid.unresolved.length > 0);
  }
});

test("static side-effect imports supply already-fetched related modules", async () => {
  const { changedImportContext, relatedChangedContext } =
    await import("./paired-review-context.mjs");
  const files = [
    {
      filename: "src/main.ts",
      before: "import './register.js';\n",
      after:
        'import "./register.js";\nimport("./dynamic.js");\nrequire("./common.js");\nimport "./absent.js";',
    },
    {
      filename: "src/register.ts",
      before: "register(oldHandler);",
      after: "register(newHandler);",
    },
    { filename: "src/dynamic.ts", before: "dynamic();", after: "dynamic();" },
    { filename: "src/common.ts", before: "common();", after: "common();" },
  ];
  assert.deepEqual(changedImportContext(files, new Set([0])), [1]);
  assert.deepEqual(relatedChangedContext(files, new Set([0])), [0, 1]);
});

test("local JSON pointers to intermediate objects receive the complete exact object", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  const before = JSON.stringify(
    {
      components: {
        schemas: {
          A: { description: "🙂", type: "string" },
          B: { type: "number" },
        },
      },
    },
    null,
    2,
  );
  const after = before.replace('"number"', '"boolean"');
  const files = [{ filename: "api.json", before, after }];
  const units = [
    {
      label: "reference",
      parts: [
        {
          text: '{"$ref":"#/components/schemas"}',
          references: ["before", "after"].map((side) => ({
            fileIndex: 0,
            side,
            start: 0,
            end: 0,
            lineStart: 1,
          })),
        },
      ],
    },
  ];
  const result = jsonReferenceContext(files, units);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.contexts.length, 2);
  for (const context of result.contexts) {
    assert.equal(context.pointer, "/components/schemas");
    const part = context.parts[0];
    assert.equal(
      Buffer.from(files[0][part.side])
        .subarray(part.start, part.end)
        .toString(),
      part.text,
    );
    assert.deepEqual(JSON.parse("{" + part.text + "}"), {
      schemas: JSON.parse(files[0][part.side]).components.schemas,
    });
  }
});

test("fully supplied JSON still reports nonexistent and malformed local pointers", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  for (const ref of [
    "#/missing",
    "#/components/missing",
    "#not-a-pointer",
    "#/%zz",
    "#/components/~2",
  ]) {
    const source = JSON.stringify({
      $ref: ref,
      components: { schemas: { A: { type: "string" } } },
    });
    const files = [{ filename: "api.json", before: source, after: source }];
    const result = jsonReferenceContext(files, pairedUnits(files));
    assert.ok(result.unresolved.length > 0, ref);
  }
  const source = JSON.stringify({
    $ref: "#/components/schemas",
    components: { schemas: { A: { type: "string" } } },
  });
  const files = [{ filename: "api.json", before: source, after: source }];
  const result = jsonReferenceContext(files, [
    {
      label: "whole",
      parts: [
        {
          text: source,
          references: [
            {
              fileIndex: 0,
              side: "after",
              start: 0,
              end: Buffer.byteLength(source),
              lineStart: 1,
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(result, { contexts: [], unresolved: [] });
});

test("valid fully covered root pointers add no repeated context", async () => {
  const { jsonReferenceContext } = await import("./paired-review-context.mjs");
  const source = '{"$ref":"#","title":"🙂"}';
  const files = [{ filename: "api.json", before: source, after: source }];
  assert.deepEqual(jsonReferenceContext(files, pairedUnits(files)), {
    contexts: [],
    unresolved: [],
  });
});

test("supplemental changed hunks reuse overlapping exact source ranges", async () => {
  const { supplementalUnits } = await import("./paired-review-context.mjs");
  const before = Array.from(
    { length: 120 },
    (_, i) => `${i}: ${"x".repeat(400)}\n`,
  ).join("");
  const after = before
    .replace("40: ", "changed40: ")
    .replace("45: ", "changed45: ");
  const file = { filename: "src/large.ts", before, after };
  const parts = supplementalUnits([file], 0);
  assert.ok(
    parts.some((part) => part.otherSides?.length),
    "identical revision context must carry both exact references once",
  );
  const expanded = parts.flatMap((part) => [
    part,
    ...(part.otherSides ?? []).map((reference) => ({
      ...reference,
      text: part.text,
    })),
  ]);
  for (const side of ["before", "after"]) {
    const ranges = expanded
      .filter((part) => part.side === side)
      .sort((a, b) => a.start - b.start);
    assert.ok(ranges.length > 0);
    for (let i = 0; i < ranges.length; i++) {
      const part = ranges[i];
      assert.equal(
        part.text,
        Buffer.from(file[side]).subarray(part.start, part.end).toString("utf8"),
      );
      if (i)
        assert.ok(
          ranges[i - 1].end <= part.start,
          "overlapping source must be supplied once",
        );
    }
    assert.ok(
      ranges.some((part) =>
        part.text.includes(side === "before" ? "40: " : "changed40: "),
      ),
    );
    assert.ok(
      ranges.some((part) =>
        part.text.includes(side === "before" ? "45: " : "changed45: "),
      ),
    );
  }
});

test("changed Convex call references include their exact query implementation as context", async () => {
  const { changedImportContext } = await import("./paired-review-context.mjs");
  const files = [
    {
      filename: "app/src/adapter.ts",
      before: null,
      after: 'makeFunctionReference<"query">("developmentState:liveWork")',
    },
    { filename: "app/convex/developmentState.ts", before: "old", after: "new" },
  ];
  assert.deepEqual(changedImportContext(files, new Set([0])), [1]);
  assert.deepEqual(
    changedImportContext(
      [...files, { ...files[1], filename: "other/convex/developmentState.ts" }],
      new Set([0]),
    ),
    [],
    "ambiguous backend roots must not be guessed",
  );
});

test("generated Convex API namespace references link the changed backend module", async () => {
  const { changedImportContext } = await import("./paired-review-context.mjs");
  const files = [
    {
      filename: "app/src/adapter.ts",
      before: null,
      after:
        'import { api } from "../../convex/_generated/api.js"; const functions = api.developmentState;',
    },
    { filename: "app/convex/developmentState.ts", before: "old", after: "new" },
  ];
  assert.deepEqual(changedImportContext(files, new Set([0])), [1]);
});

test("compact supplemental context retains complete changed hunks with exact bounded surroundings", async () => {
  const { supplementalUnits } = await import("./paired-review-context.mjs");
  const before = Array.from(
    { length: 90 },
    (_, i) => `${i}: ${"x".repeat(120)}\n`,
  ).join("");
  const after = before.replace("40: ", "changed40: ");
  const file = { filename: "src/app.ts", before, after };
  const full = supplementalUnits([file], 0);
  const compact = supplementalUnits([file], 0, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(compact)) <
      Buffer.byteLength(JSON.stringify(full)) / 2,
  );
  assert.ok(compact.some((part) => part.text.includes("changed40: ")));
  for (const part of compact)
    for (const reference of [part, ...(part.otherSides ?? [])])
      assert.equal(
        part.text,
        Buffer.from(file[reference.side])
          .subarray(reference.start, reference.end)
          .toString("utf8"),
      );
});
