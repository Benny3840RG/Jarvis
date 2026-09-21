import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const target = "https://outgoing-ram-798.convex.cloud";
const sha = "a".repeat(40);
const noChange = {
  authDiff: { added: [], removed: [] },
  definitionDiffs: {},
  componentDiffs: {
    "": {
      diffType: { type: "modify" },
      moduleDiff: { added: [], removed: [] },
      udfConfigDiff: null,
      cronDiff: { added: [], updated: [], deleted: [] },
      indexDiff: { added_indexes: [], removed_indexes: [] },
      schemaDiff: null,
    },
  },
};

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-deploy-test-"));
  const state = join(dir, ".local/state/jarvis-convex");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const key = join(state, "dev-outgoing-ram-798.env");
  const receipt = join(state, "last-dry-run-receipt.json");
  writeFileSync(key, "CONVEX_DEPLOY_KEY=dev:outgoing-ram-798|fake-test-only-key", { mode: 0o600 });
  const fixture = join(dir, "provider.json");
  const calls = join(dir, "calls.jsonl");
  const preload = join(dir, "preload.mjs");
  // Keep receipt IO real. Isolate homedir/git/provider boundaries so no real
  // credentials, repository mutations or network calls can occur.
  writeFileSync(
    preload,
    `
import os from 'node:os';
import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
os.homedir = () => ${JSON.stringify(dir)};
cp.execFileSync = (_exe, args) => Buffer.from(args[0] === 'status' ? '' : '${sha}');
cp.spawnSync = (_exe, args, options) => {
  const input = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, envKeys:Object.keys(options.env)})+'\\n');
  const text = '${target}\\n' + (input.message || '') + '\\n' + (args.includes('--verbose') ? 'startPush: '+JSON.stringify({schemaChange:{...(input.startSchemaChange || {}),indexDiffs:input.startIndexes},environmentVariables:{PRIVATE_TEST_VALUE:'never-print-this-provider-secret'}}, null, 2)+'\\n'+JSON.stringify(input.plan, null, 2) : 'Would have deployed') + '\\n';
  return {status:input.status??0, stdout:Buffer.from(text), stderr:Buffer.alloc(0)};
};
if (process.env.JARVIS_TEST_RECEIPT_RACE === '1') {
 const unlink = fs.unlinkSync;
 fs.unlinkSync = (path) => { if (String(path).endsWith('last-dry-run-receipt.json')) { const error=new Error('another process consumed receipt'); error.code='ENOENT'; throw error; } return unlink(path); };
}
syncBuiltinESMExports();
`,
  );
  function run(
    mode: string,
    plan: unknown = noChange,
    status = 0,
    message = "",
    startIndexes: unknown = {},
    receiptRace = false,
    startSchemaChange: Record<string, unknown> = {},
  ) {
    writeFileSync(fixture, JSON.stringify({ plan, status, message, startIndexes, startSchemaChange }));
    return spawnSync(
      process.execPath,
      ["--import", preload, resolve("scripts/convex-deploy-dev-outgoing-ram-798.mjs"), mode],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          JARVIS_SERVICE_TOKEN: "unrelated-secret",
          NODE_OPTIONS: "",
          JARVIS_TEST_RECEIPT_RACE: receiptRace ? "1" : "0",
        },
      },
    );
  }
  return {
    dir,
    key,
    receipt,
    run,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; envKeys: string[] })
        : [],
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a rejected replacement dry run invalidates the previous receipt", () => {
  const h = harness();
  try {
    assert.equal(h.run("--dry-run").status, 0);
    assert.equal(existsSync(h.receipt), true);
    assert.notEqual(h.run("--dry-run", noChange, 1).status, 0);
    assert.equal(existsSync(h.receipt), false);
    assert.notEqual(h.run("--deploy").status, 0);
    assert.equal(
      h.calls().some((c) => !c.args.includes("--dry-run")),
      false,
    );
  } finally {
    h.close();
  }
});

for (const timestamp of [undefined, null, "bad", Date.now() + 86_400_000, 0]) {
  test(`deploy refuses invalid or expired receipt time ${String(timestamp)}`, () => {
    const h = harness();
    try {
      assert.equal(h.run("--dry-run").status, 0);
      const receipt = JSON.parse(readFileSync(h.receipt, "utf8"));
      writeFileSync(h.receipt, JSON.stringify({ ...receipt, createdAtMs: timestamp }));
      assert.notEqual(h.run("--deploy").status, 0);
      assert.equal(
        h.calls().some((c) => !c.args.includes("--dry-run")),
        false,
      );
    } finally {
      h.close();
    }
  });
}

for (const kind of ["index", "function", "missing-plan"]) {
  test(`verify refuses ${kind} drift or unavailable structured evidence`, () => {
    const h = harness();
    try {
      const plan = structuredClone(noChange);
      if (kind === "function")
        (plan.componentDiffs[""].moduleDiff.added as string[]).push("tasks.js");
      if (kind === "index")
        (plan.componentDiffs[""].indexDiff.added_indexes as unknown[]).push({
          name: "tasks.by_name",
          type: "database",
          fields: ["name"],
        });
      assert.notEqual(h.run("--verify", kind === "missing-plan" ? {} : plan).status, 0);
      assert.equal(existsSync(h.receipt), false);
    } finally {
      h.close();
    }
  });
}

test("deploy rechecks the approved plan before invoking a mutating child", () => {
  const h = harness();
  try {
    assert.equal(h.run("--dry-run").status, 0);
    const changed = structuredClone(noChange);
    (changed.componentDiffs[""].moduleDiff.removed as string[]).push("tasks.js");
    assert.notEqual(h.run("--deploy", changed).status, 0);
    assert.equal(
      h.calls().some((c) => !c.args.includes("--dry-run")),
      false,
    );
    assert.equal(existsSync(h.receipt), false);
  } finally {
    h.close();
  }
});

test("provider receives only deployment credentials and verification proves no changes", () => {
  const h = harness();
  try {
    assert.equal(h.run("--verify").status, 0);
    assert.equal(h.calls()[0].envKeys.includes("JARVIS_SERVICE_TOKEN"), false);
    assert.equal(h.calls()[0].envKeys.includes("NODE_OPTIONS"), false);
    assert.equal(h.calls()[0].envKeys.includes("CONVEX_DEPLOY_KEY"), true);
    assert.equal(existsSync(h.receipt), false);
  } finally {
    h.close();
  }
});

test("successful receipt permits one deployment only", () => {
  const h = harness();
  try {
    assert.equal(h.run("--dry-run").status, 0);
    assert.equal(h.run("--deploy").status, 0);
    assert.notEqual(h.run("--deploy").status, 0);
    assert.equal(h.calls().filter((c) => !c.args.includes("--dry-run")).length, 1);
  } finally {
    h.close();
  }
});

for (const mode of ["public-key", "symlink-key", "public-directory"]) {
  test(`unsafe credential path ${mode} refuses before provider access`, () => {
    const h = harness();
    try {
      if (mode === "public-key") chmodSync(h.key, 0o644);
      if (mode === "public-directory") chmodSync(join(h.dir, ".local/state/jarvis-convex"), 0o755);
      if (mode === "symlink-key") {
        const destination = join(h.dir, "other-key");
        writeFileSync(destination, readFileSync(h.key), { mode: 0o600 });
        unlinkSync(h.key);
        symlinkSync(destination, h.key);
      }
      assert.notEqual(h.run("--dry-run").status, 0);
      assert.equal(h.calls().length, 0);
    } finally {
      h.close();
    }
  });
}

test("changed receipt target and changed nondestructive plan refuse deployment", () => {
  const h = harness();
  try {
    assert.equal(h.run("--dry-run").status, 0);
    const receipt = JSON.parse(readFileSync(h.receipt, "utf8"));
    writeFileSync(h.receipt, JSON.stringify({ ...receipt, target: "https://elsewhere.invalid" }));
    assert.notEqual(h.run("--deploy").status, 0);
    assert.equal(h.run("--dry-run").status, 0);
    const changed = structuredClone(noChange);
    (changed.componentDiffs[""].moduleDiff.added as string[]).push("new-function.js");
    assert.notEqual(h.run("--deploy", changed).status, 0);
    assert.equal(
      h.calls().some((c) => !c.args.includes("--dry-run")),
      false,
    );
  } finally {
    h.close();
  }
});

test("a matching additive function plan can deploy but cannot pass verification before landing", () => {
  const h = harness();
  try {
    const changed = structuredClone(noChange);
    (changed.componentDiffs[""].moduleDiff.added as string[]).push("new-function.js");
    assert.equal(h.run("--dry-run", changed).status, 0);
    assert.equal(h.run("--deploy", changed).status, 0);
    assert.notEqual(h.run("--verify", changed).status, 0);
    assert.equal(h.run("--verify").status, 0);
  } finally {
    h.close();
  }
});

test("empty CLI runtime-diff heading is not a change, but version entries are refused", () => {
  const h = harness();
  try {
    assert.equal(
      h.run("--verify", noChange, 0, "Change the server's version for Node.js actions:\n  \n")
        .status,
      0,
    );
    assert.notEqual(
      h.run(
        "--dry-run",
        noChange,
        0,
        "Change the server's version for Node.js actions:\n  [-] 22\n  [+] 24\n",
      ).status,
      0,
    );
    assert.equal(existsSync(h.receipt), false);
  } finally {
    h.close();
  }
});

test("CLI uses only the private explicit env file and suppresses verbose provider secrets", () => {
  const h = harness();
  try {
    const result = h.run("--verify");
    assert.equal(result.status, 0);
    const args = h.calls()[0].args;
    assert.equal(args[args.indexOf("--env-file") + 1], h.key);
    assert.equal(args.join(" ").includes("fake-test-only-key"), false);
    assert.equal(
      (result.stdout + result.stderr).includes("never-print-this-provider-secret"),
      false,
    );
  } finally {
    h.close();
  }
});
for (const effect of ["added_indexes", "removed_indexes"]) {
  test(`start-only ${effect} prevents false no-change verification`, () => {
    const h = harness();
    try {
      const indexes = { added_indexes: [], removed_indexes: [] } as Record<string, unknown[]>;
      indexes[effect].push({ name: "tasks.by_name", type: "database", fields: ["name"] });
      assert.notEqual(h.run("--verify", noChange, 0, "", { "": indexes }).status, 0);
      if (effect === "removed_indexes") {
        assert.notEqual(h.run("--dry-run", noChange, 0, "", { "": indexes }).status, 0);
        assert.equal(existsSync(h.receipt), false);
      }
    } finally {
      h.close();
    }
  });
}

test("explicit null start-phase indexDiffs is refused, not treated as no pending changes", () => {
  const h = harness();
  try {
    assert.notEqual(h.run("--verify", noChange, 0, "", null).status, 0);
    assert.notEqual(h.run("--dry-run", noChange, 0, "", null).status, 0);
    assert.equal(existsSync(h.receipt), false);
  } finally {
    h.close();
  }
});

test("a falsy but present root component diff is refused, not treated as no root change", () => {
  const h = harness();
  try {
    const plan = { ...structuredClone(noChange), componentDiffs: { "": false } };
    assert.notEqual(h.run("--verify", plan).status, 0);
    assert.notEqual(h.run("--dry-run", plan).status, 0);
    assert.equal(existsSync(h.receipt), false);
  } finally {
    h.close();
  }
});

test("a receipt consumed by a competing process cannot authorize a second deployment", () => {
  const h = harness();
  try {
    assert.equal(h.run("--dry-run").status, 0);
    assert.notEqual(h.run("--deploy", noChange, 0, "", {}, true).status, 0);
    assert.equal(
      h.calls().some((c) => !c.args.includes("--dry-run")),
      false,
    );
  } finally {
    h.close();
  }
});


for (const [field, value] of [
  ["allocatedComponentIds", { root: "component-id" }],
  ["schemaIds", { root: "schema-id" }],
  ["allocatedComponentIds", []],
] as const) {
  test(`unsupported start-phase ${field} evidence fails closed`, () => {
    const h = harness();
    try {
      assert.notEqual(h.run("--dry-run", noChange, 0, "", {}, false, { [field]: value }).status, 0);
      assert.equal(existsSync(h.receipt), false);
    } finally {
      h.close();
    }
  });
}

test("empty start-phase allocation maps are accepted", () => {
  const h = harness();
  try {
    assert.equal(
      h.run("--verify", noChange, 0, "", {}, false, {
        allocatedComponentIds: {},
        schemaIds: {},
      }).status,
      0,
    );
  } finally {
    h.close();
  }
});
