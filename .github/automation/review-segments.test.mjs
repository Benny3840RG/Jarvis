import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPlan,
  aggregateSegments,
  segmentReceipt,
  validateReviewPlan,
} from "./review-segments.mjs";
const identity = {
  pullNumber: 502,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  fingerprint: "c".repeat(64),
};
const make = (files) =>
  buildReviewPlan({
    identity,
    repository: "owner/repo",
    runId: 123,
    runAttempt: 1,
    files,
  });
const file = (text) => ({
  filename: "typescript/openapi/jarvis.openapi.json",
  status: "modified",
  before: text,
  after: text + "\n",
});
const raw = JSON.stringify({
  verdict: "pass",
  summary: "Supplied segment reviewed.",
  findings: [],
  contextRequests: [],
});
test("oversized full files retain all UTF8 bytes in bounded complete segments", () => {
  const text = "🙂é schema\n".repeat(30000);
  const plan = make([file(text)]);
  assert.ok(plan.prompts.length > 1);
  assert.ok(plan.prompts.length <= 16);
  for (const prompt of plan.prompts)
    assert.ok(Buffer.byteLength(prompt) <= 160 * 1024);
  validateReviewPlan(plan);
  for (const side of ["before", "after"]) {
    const pieces = plan.prompts
      .flatMap((prompt) =>
        JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).units.flatMap(
          (unit) =>
            unit.parts.flatMap((part) =>
              part.references.map((reference) => ({
                ...reference,
                text: part.text,
              })),
            ),
        ),
      )
      .filter((part) => part.side === side);
    let next = 0;
    for (const part of pieces) {
      assert.equal(part.start, next);
      assert.equal(Buffer.byteLength(part.text), part.end - part.start);
      next = part.end;
    }
    assert.equal(
      pieces.map((part) => part.text).join(""),
      side === "before" ? text : text + "\n",
    );
  }
  const receipts = plan.prompts.map((_, index) =>
    segmentReceipt(plan, index, raw),
  );
  assert.equal(aggregateSegments(plan, receipts).verdict, "pass");
});
test("coverage rejects gaps duplicates wrong digest and candidate identity", () => {
  const plan = make([file("hello")]);
  for (const mutate of [
    (p) => p.manifest.segments[0].ranges[0].start++,
    (p) => p.manifest.segments.push(p.manifest.segments[0]),
    (p) => (p.manifest.files[0].before.digest = "0".repeat(64)),
    (p) => (p.manifest.identity.headSha = "d".repeat(40)),
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateReviewPlan(changed));
  }
});
test("missing duplicate mismatched truncated and context-requested results block", () => {
  const plan = make([file("hello")]);
  const receipt = segmentReceipt(plan, 0, raw);
  for (const receipts of [
    [],
    [receipt, receipt],
    [{ ...receipt, manifestDigest: "0".repeat(64) }],
    [{ ...receipt, raw: "{" }],
    [
      segmentReceipt(
        plan,
        0,
        JSON.stringify({
          verdict: "pass",
          summary: "need more",
          findings: [],
          contextRequests: ["other segment"],
        }),
      ),
    ],
  ])
    assert.equal(aggregateSegments(plan, receipts).verdict, "blocked");
});
test("caps cannot be expanded by oversized files or excessive escaped content", () => {
  assert.throws(() => make([file("x".repeat(512 * 1024 + 1))]));
  assert.throws(() =>
    make(
      Array.from({ length: 17 }, (_, i) => ({
        ...file("x".repeat(150000)),
        filename: `file-${i}.ts`,
      })),
    ),
  );
  assert.throws(() =>
    make(
      Array.from({ length: 41 }, (_, i) => ({
        ...file("a"),
        filename: `file-${i}.ts`,
      })),
    ),
  );
});
test("empty added removed renamed sides remain explicit and findings are bounded", () => {
  const plan = make([
    { filename: "new.ts", status: "added", before: null, after: "" },
    { filename: "old.ts", status: "removed", before: "gone", after: null },
    {
      filename: "renamed.ts",
      previousFilename: "original.ts",
      status: "renamed",
      before: "before",
      after: "after",
    },
  ]);
  validateReviewPlan(plan);
  const receipts = plan.prompts.map((_, i) => segmentReceipt(plan, i, raw));
  assert.equal(aggregateSegments(plan, receipts).verdict, "pass");
  receipts[0] = segmentReceipt(
    plan,
    0,
    JSON.stringify({
      verdict: "changes_requested",
      summary: "defect",
      findings: [
        { file: "unknown", line: 1, severity: "high", message: "bad" },
      ],
      contextRequests: [],
    }),
  );
  assert.equal(aggregateSegments(plan, receipts).verdict, "blocked");
});

test("single-line escaped Unicode survives serialization without dropped bytes", () => {
  const text = '\u0001🙂"'.repeat(7000);
  const plan = make([file(text)]);
  for (const prompt of plan.prompts)
    assert.ok(Buffer.byteLength(prompt) <= 160 * 1024);
  const parts = plan.prompts.flatMap((prompt) =>
    JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).units.flatMap((unit) =>
      unit.parts.flatMap((part) =>
        part.references.map((reference) => ({ ...reference, text: part.text })),
      ),
    ),
  );
  assert.equal(
    parts
      .filter((part) => part.side === "before")
      .map((part) => part.text)
      .join(""),
    text,
  );
});

test("invalid run attempts sides rename paths and altered CI cannot supply coverage", () => {
  const plan = make([file("hello")]);
  for (const change of [
    { runId: 0 },
    { runId: 1.5 },
    { runAttempt: 0 },
    { runAttempt: 3 },
  ])
    assert.throws(() => buildReviewPlan({ ...plan.input, ...change }));
  for (const changed of [
    { ...file("hello"), before: null },
    { ...file("hello"), status: "added" },
    { ...file("hello"), status: "renamed", previousFilename: "../escape.ts" },
    { ...file("hello"), status: "renamed", previousFilename: "/absolute.ts" },
  ])
    assert.throws(() => make([changed]));
  const altered = structuredClone(plan);
  altered.manifest.ci = { ok: true, pending: [], problems: [] };
  assert.throws(() => validateReviewPlan(altered));
});

test("supplemental changed import schema is bound to the same source and prompt digest", () => {
  const plan = make([
    {
      filename: "src/controller.ts",
      status: "added",
      before: null,
      after:
        'import {schema} from "./schema.js";\n' + "// context\n".repeat(10500),
    },
    {
      filename: "src/schema.ts",
      status: "added",
      before: null,
      after: 'export const schema = {transitionId: "MERGE_CONFIRMED"};',
    },
  ]);
  const prompt = plan.prompts
    .map((p) => JSON.parse(p.split("\n\n")[1]))
    .find((p) => p.supplemental.length);
  assert.ok(prompt);
  assert.ok(JSON.stringify(prompt.supplemental).includes("MERGE_CONFIRMED"));
  const forged = structuredClone(plan);
  forged.prompts[0] += "altered";
  assert.throws(() => validateReviewPlan(forged));
});

test("oversized atomic JSON context blocks instead of splitting a semantic object", () => {
  const before = JSON.stringify({
    paths: { "/huge": { description: "x".repeat(120000) } },
  });
  const after = before.replace("xxx", "yyy");
  assert.throws(
    () => make([{ ...file(before), after }]),
    /paired semantic review unit/,
  );
});

test("duplicate semantic keys cannot erase source coverage", () => {
  const text =
    '{"paths":{"/a":{"description":"' + "x".repeat(100000) + '"},"/a":{}}}';
  assert.throws(() => make([file(text)]), /coverage/);
});

test("client review includes complete related contract/controller and changed server registration", () => {
  const serverBefore =
    'import {client} from "./client.js";\n' +
    Array.from({ length: 10000 }, (_, i) => `const value${i} = ${i};\n`).join(
      "",
    );
  const plan = make([
    {
      filename: "src/client.ts",
      status: "added",
      before: null,
      after:
        'import {Contract} from "./contract.js"; export const client = true;',
    },
    {
      filename: "src/server.ts",
      status: "modified",
      before: serverBefore,
      after: serverBefore.replace(
        "const value9000 = 9000;",
        "const getLiveWork = client;",
      ),
    },
    {
      filename: "src/contract.ts",
      status: "added",
      before: null,
      after: "export type Contract = { liveWork: string };",
    },
    {
      filename: "src/controller.ts",
      status: "added",
      before: null,
      after:
        'import {Contract} from "./contract.js"; export const controller = true;',
    },
  ]);
  const content = plan.prompts
    .map((p) => JSON.parse(p.split("\n\n")[1]))
    .find((p) =>
      p.units.some((u) =>
        u.parts.some((part) => part.references.some((r) => r.fileIndex === 0)),
      ),
    );
  const text = JSON.stringify(content);
  assert.ok(text.includes("getLiveWork"));
  assert.ok(text.includes("export type Contract"));
  assert.ok(text.includes("export const controller"));
});

test("valid findings on either paired side and identical UTF8 spans retain changes_requested", () => {
  const plan = make([
    {
      filename: "added.ts",
      status: "added",
      before: null,
      after: "🙂 added\nintroduced();\n",
    },
    {
      filename: "removed.ts",
      status: "removed",
      before: "é removed\nremovedGuard();\n",
      after: null,
    },
    {
      filename: "paired.ts",
      status: "modified",
      before: "old();\n",
      after: "new();\nadded();\n",
    },
    {
      filename: "identical.ts",
      status: "modified",
      before: "🙂 unchanged\nexisting();",
      after: "🙂 unchanged\nexisting();",
    },
  ]);
  for (const [file, line] of [
    ["added.ts", 2],
    ["removed.ts", 2],
    ["paired.ts", 2],
    ["identical.ts", 2],
  ]) {
    const finding = {
      file,
      line,
      severity: "high",
      message: "Introduced change requires correction.",
    };
    const receipts = plan.prompts.map((_, index) =>
      segmentReceipt(
        plan,
        index,
        JSON.stringify({
          verdict: "changes_requested",
          summary: "Concrete defect.",
          findings: [finding],
          contextRequests: [],
        }),
      ),
    );
    const result = aggregateSegments(plan, receipts);
    assert.equal(result.verdict, "changes_requested", file);
    assert.deepEqual(result.findings, [finding]);
  }
});

test("findings cannot borrow supplemental source or another segment's primary ranges", () => {
  const text =
    'import { helper } from "./helper.js";\n' +
    Array.from({ length: 6500 }, (_, i) => `const item${i} = "🙂";\n`).join("");
  const plan = make([
    {
      filename: "main.ts",
      status: "modified",
      before: text,
      after: text + "helper();\n",
    },
    {
      filename: "helper.ts",
      status: "modified",
      before: "export const helper = () => 1;\n",
      after: "export const helper = () => 2;\n",
    },
  ]);
  for (const prompt of plan.prompts) {
    const protocol = prompt.slice(0, prompt.indexOf("\n\n"));
    assert.match(
      protocol,
      /Findings must cite a file and line covered by this segment's primary units\.parts\.references/,
    );
    assert.match(
      protocol,
      /Supplemental context may inform review but does not authorize finding locations/,
    );
    assert.match(
      protocol,
      /If essential primary source or context is missing, return blocked with contextRequests/,
    );
  }
  const payloads = plan.prompts.map((p) =>
    JSON.parse(p.slice(p.indexOf("\n\n") + 2)),
  );
  for (const [index, payload] of payloads.entries()) {
    const reference = payload.units
      .flatMap((u) => u.parts.flatMap((part) => part.references))
      .find((r) => r.fileIndex === 0 && r.lineStart > 1);
    if (!reference) continue;
    const finding = {
      file: "main.ts",
      line: reference.lineStart,
      severity: "high",
      message: "Supplied UTF8 source at its actual line.",
    };
    const receipts = plan.prompts.map((_, i) =>
      segmentReceipt(
        plan,
        i,
        i === index
          ? JSON.stringify({
              verdict: "changes_requested",
              summary: "Concrete defect.",
              findings: [finding],
              contextRequests: [],
            })
          : raw,
      ),
    );
    const result = aggregateSegments(plan, receipts);
    assert.equal(result.verdict, "changes_requested");
    assert.deepEqual(result.findings, [finding]);
  }
  const supplementalIndex = payloads.findIndex(
    (p) =>
      p.supplemental.some((c) => c.fileIndex === 1) &&
      !p.units.some((u) =>
        u.parts.some((part) => part.references.some((r) => r.fileIndex === 1)),
      ),
  );
  assert.ok(supplementalIndex >= 0);
  const lateIndex = payloads.findIndex((p) =>
    p.units.every((u) =>
      u.parts.every((part) =>
        part.references.every((r) => r.fileIndex !== 0 || r.lineStart > 1),
      ),
    ),
  );
  assert.ok(lateIndex >= 0);
  for (const [index, file, line] of [
    [supplementalIndex, "helper.ts", 1],
    [lateIndex, "main.ts", 1],
    [0, "main.ts", 999999],
  ]) {
    const receipts = plan.prompts.map((_, i) =>
      segmentReceipt(
        plan,
        i,
        i === index
          ? JSON.stringify({
              verdict: "changes_requested",
              summary: "Outside primary coverage.",
              findings: [
                { file, line, severity: "high", message: "Not supplied here." },
              ],
              contextRequests: [],
            })
          : raw,
      ),
    );
    assert.equal(aggregateSegments(plan, receipts).verdict, "blocked");
  }
});

test("empty sides and end-exclusive newline boundaries do not authorize findings", () => {
  const plan = make([
    { filename: "empty.ts", status: "added", before: null, after: "" },
    {
      filename: "line.ts",
      status: "modified",
      before: "before;\n",
      after: "after;\n",
    },
  ]);
  for (const [file, line] of [
    ["empty.ts", 1],
    ["line.ts", 2],
  ]) {
    const receipts = [
      segmentReceipt(
        plan,
        0,
        JSON.stringify({
          verdict: "changes_requested",
          summary: "No source bytes on this line.",
          findings: [
            {
              file,
              line,
              severity: "high",
              message: "Outside primary source.",
            },
          ],
          contextRequests: [],
        }),
      ),
    ];
    assert.equal(aggregateSegments(plan, receipts).verdict, "blocked");
  }
});

test("side-effect registration context is actually packed within the unchanged prompt bound", () => {
  const text =
    'import "./registration.js";\n' +
    Array.from({ length: 6500 }, (_, i) => `const item${i} = "🙂";\n`).join("");
  const plan = make([
    {
      filename: "main.ts",
      status: "modified",
      before: text,
      after: text + "start();\n",
    },
    {
      filename: "registration.ts",
      status: "modified",
      before: "register(oldHandler);",
      after: "register(newHandler);",
    },
  ]);
  const first = JSON.parse(plan.prompts[0].split("\n\n")[1]);
  assert.ok(
    first.supplemental.some(
      (context) =>
        context.fileIndex === 1 &&
        context.parts.some((part) =>
          part.text.includes("register(newHandler)"),
        ),
    ),
  );
  validateReviewPlan(plan);
  assert.ok(
    plan.prompts.every((prompt) => Buffer.byteLength(prompt) <= 160 * 1024),
  );
});

test("oversized intermediate JSON reference context remains explicitly unavailable without cutting it", () => {
  const source = JSON.stringify(
    {
      paths: { "/lookup": { get: { $ref: "#/components/schemas" } } },
      components: {
        schemas: Object.fromEntries(
          ["A", "B", "C"].map((name) => [
            name,
            { description: "x".repeat(60000) },
          ]),
        ),
      },
    },
    null,
    2,
  );
  const plan = make([
    { filename: "api.json", status: "modified", before: source, after: source },
  ]);
  const payloads = plan.prompts.map((p) => JSON.parse(p.split("\n\n")[1]));
  assert.ok(
    payloads.some((p) =>
      p.unavailableContext.some(
        (item) =>
          item.pointer === "/components/schemas" &&
          item.reason.includes("bounded"),
      ),
    ),
  );
  assert.ok(
    payloads.every(
      (p) =>
        !p.supplemental.some((item) => item.pointer === "/components/schemas"),
    ),
  );
  assert.ok(plan.prompts.length <= 16);
  assert.ok(
    plan.prompts.every((prompt) => Buffer.byteLength(prompt) <= 160 * 1024),
  );
  validateReviewPlan(plan);
});

test("compact context reaches every related changed module before expanding one module", () => {
  const imports = Array.from(
    { length: 12 },
    (_, i) => `import { value${i} } from "./module${i}.js";\n`,
  ).join("");
  const large = Array.from(
    { length: 80 },
    (_, i) => `// unique${i} ${"x".repeat(950)}\n`,
  ).join("");
  const modules = Array.from({ length: 12 }, (_, i) => {
    const before =
      Array.from(
        { length: 130 },
        (_, j) => `// module${i}-${j} ${"y".repeat(120)}\n`,
      ).join("") + `export const value${i} = 0;\n`;
    return {
      filename: `src/module${i}.ts`,
      status: "modified",
      before,
      after: before.replace(`value${i} = 0`, `value${i} = 1`),
    };
  });
  const plan = make([
    {
      filename: "src/entry.ts",
      status: "modified",
      before: imports + large + "old();\n",
      after: imports + large + "ENTRY_CHANGED();\n",
    },
    ...modules,
  ]);
  const prompt = plan.prompts
    .map((text) => JSON.parse(text.split("\n\n")[1]))
    .find((entry) =>
      entry.units.some((unit) =>
        unit.parts.some((part) => part.text.includes("ENTRY_CHANGED")),
      ),
    );
  assert.ok(prompt);
  for (let i = 1; i <= 12; i++)
    assert.ok(
      prompt.supplemental.some((context) => context.fileIndex === i),
      `missing changed module${i - 1}`,
    );
  validateReviewPlan(plan);
});

test("JSON segments retain bounded inserted entries between their paired source ranges", () => {
  const entries = Array.from({ length: 220 }, (_, i) => [
    `/api/v1/existing${i}`,
    { get: { description: `existing${i} ${"x".repeat(450)}` } },
  ]);
  const inserted = [
    "/api/v1/inserted",
    { get: { description: `新🙂 ${"z".repeat(1800)}` } },
  ];
  const before = JSON.stringify(
    { paths: Object.fromEntries(entries), components: { schemas: {} } },
    null,
    2,
  );
  const after = JSON.stringify(
    {
      paths: Object.fromEntries([
        ...entries.slice(0, 60),
        inserted,
        ...entries.slice(60),
      ]),
      components: {
        schemas: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [
            `New${i}`,
            { description: "y".repeat(1900) },
          ]),
        ),
      },
    },
    null,
    2,
  );
  const plan = make([
    { filename: "api.json", status: "modified", before, after },
  ]);
  const source = Buffer.from(after);
  const marker = source.indexOf(Buffer.from('"/api/v1/inserted"'));
  let witnessed = false;
  for (const prompt of plan.prompts) {
    const payload = JSON.parse(prompt.split("\n\n")[1]);
    const ranges = payload.manifest.segments[
      payload.segmentIndex
    ].ranges.filter((range) => range.side === "after");
    for (let i = 1; i < ranges.length; i++) {
      const start = ranges[i - 1].end,
        end = ranges[i].start;
      if (start <= marker && end > marker) {
        witnessed = true;
        assert.ok(
          payload.supplemental.some((context) =>
            context.parts.some(
              (part) =>
                part.side === "after" &&
                part.start === start &&
                part.end === end &&
                part.text === source.subarray(start, end).toString("utf8"),
            ),
          ),
          "inserted semantic entry missing between paired neighboring ranges",
        );
      }
    }
    assert.ok(Buffer.byteLength(prompt) <= 160 * 1024);
  }
  assert.equal(witnessed, true);
  validateReviewPlan(plan);
});

test("oversized intervening JSON source stays explicitly unavailable within existing limits", () => {
  const entries = Array.from({ length: 100 }, (_, i) => [
    `/api/v1/existing${i}`,
    { get: { description: "x".repeat(450) } },
  ]);
  const additions = Array.from({ length: 100 }, (_, i) => [
    `/api/v1/inserted${i}`,
    { get: { description: "y".repeat(1900) } },
  ]);
  const before = JSON.stringify(
    { paths: Object.fromEntries(entries) },
    null,
    2,
  );
  const after = JSON.stringify(
    {
      paths: Object.fromEntries([
        ...entries.slice(0, 50),
        ...additions,
        ...entries.slice(50),
      ]),
    },
    null,
    2,
  );
  const plan = make([
    { filename: "api.json", status: "modified", before, after },
  ]);
  const payloads = plan.prompts.map((prompt) =>
    JSON.parse(prompt.split("\n\n")[1]),
  );
  assert.ok(
    payloads.some((payload) =>
      payload.unavailableContext.some(
        (context) =>
          context.side === "after" &&
          context.end > context.start &&
          context.reason.includes("intervening JSON source exceeds"),
      ),
    ),
  );
  assert.ok(
    plan.prompts.every((prompt) => Buffer.byteLength(prompt) <= 160 * 1024),
  );
  assert.ok(plan.prompts.length <= 16);
  validateReviewPlan(plan);
});
