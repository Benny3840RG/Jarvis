import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARCHIVE_GROUPS,
  ArchiveManifestError,
  V4_CONTRACT_VERSION,
  assertRecoverable,
  buildManifest,
  deriveCompleteness,
  groupChecksum,
  parseManifest,
  type ArchiveGroup,
  type ArchiveGroupEntry,
} from "../src/backup/archiveManifest.js";

const AT = new Date("2026-09-10T00:00:00.000Z");

function entry(group: ArchiveGroup, counts: Record<string, number> = {}): ArchiveGroupEntry {
  return {
    group,
    schemaVersion: 1,
    counts,
    checksum: groupChecksum({ group, counts }),
    consistentSnapshot: true,
  };
}

function allGroups(): ArchiveGroupEntry[] {
  return ARCHIVE_GROUPS.map((group) => entry(group));
}

describe("archive v4 manifest — completeness is derived, never asserted", () => {
  it("is partial while any required group is absent", () => {
    const manifest = buildManifest({ createdAt: AT, groups: [entry("core")] });
    assert.equal(manifest.completeness, "partial");
    assert.deepEqual(manifest.coverage.present, ["core"]);
    assert.equal(manifest.coverage.absent.length, ARCHIVE_GROUPS.length - 1);
  });

  it("is complete only once every required group is present", () => {
    assert.equal(buildManifest({ createdAt: AT, groups: allGroups() }).completeness, "complete");
  });

  it("is partial when a declared dependency points into an absent group", () => {
    const withoutQuotes = ARCHIVE_GROUPS.filter((group) => group !== "quoteAggregate");
    const manifest = buildManifest({
      createdAt: AT,
      groups: withoutQuotes.map((group) => entry(group)),
      dependencies: [
        {
          from: "businessRecords",
          to: "quoteAggregate",
          reference: "invoices.quoteId -> quotes.id",
        },
      ],
    });
    assert.equal(manifest.completeness, "partial");
  });

  it("derives the same answer as the parser regardless of what a manifest claims", () => {
    const forged = {
      ...buildManifest({ createdAt: AT, groups: [entry("core")] }),
      completeness: "complete" as const,
    };
    assert.throws(
      () => parseManifest(forged),
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /claims "complete".*derives "partial"/.test(error.message),
    );
  });
});

describe("archive v4 manifest — deriveCompleteness is the single definition", () => {
  it("requires every group, and both endpoints of every dependency", () => {
    assert.equal(deriveCompleteness([], []), "partial");
    assert.equal(deriveCompleteness(ARCHIVE_GROUPS.slice(0, -1), []), "partial");
    assert.equal(deriveCompleteness([...ARCHIVE_GROUPS], []), "complete");
    assert.equal(
      deriveCompleteness(
        [...ARCHIVE_GROUPS],
        [{ from: "core", to: "memory", reference: "buildLogs.buildId -> builds.id" }],
      ),
      "complete",
    );
  });

  it("agrees with what buildManifest stamps, for every prefix of the staged order", () => {
    for (let size = 0; size <= ARCHIVE_GROUPS.length; size += 1) {
      const groups = ARCHIVE_GROUPS.slice(0, size);
      assert.equal(
        buildManifest({ createdAt: AT, groups: groups.map((group) => entry(group)) }).completeness,
        deriveCompleteness(groups, []),
        `prefix of ${size} group(s)`,
      );
    }
  });
});

describe("archive v4 manifest — parser rejects self-inconsistent archives", () => {
  it("round-trips a well-formed manifest", () => {
    const manifest = buildManifest({
      createdAt: AT,
      groups: allGroups(),
      dependencies: [
        { from: "businessRecords", to: "core", reference: "errands.projectId -> projects.id" },
      ],
      exclusions: [
        {
          subject: "quote PDF bytes",
          reason: "regenerable",
          recoveryMethod: "re-render from quoteRevisions with the pinned rendererVersion",
        },
      ],
      blobs: [{ reference: "quotePdfArtifacts/a-1", digest: "sha256:abc", byteLength: 12 }],
    });
    assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest))), manifest);
    assert.equal(manifest.contractVersion, V4_CONTRACT_VERSION);
  });

  it("refuses an exclusion with no recovery method", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    const tampered = {
      ...manifest,
      exclusions: [{ subject: "delivery ledger", reason: "large" }],
    };
    assert.throws(() => parseManifest(tampered), /recoveryMethod must be a non-empty string/);
  });

  it("refuses coverage that disagrees with the groups actually present", () => {
    const manifest = buildManifest({ createdAt: AT, groups: [entry("core")] });
    assert.throws(
      () => parseManifest({ ...manifest, coverage: { ...manifest.coverage, present: [] } }),
      /coverage.present disagrees with manifest.groups/,
    );
    assert.throws(
      () =>
        parseManifest({
          ...manifest,
          coverage: { ...manifest.coverage, absent: [...ARCHIVE_GROUPS] },
        }),
      /coverage.absent disagrees with manifest.groups/,
    );
  });

  it("refuses an unknown contract version, unknown fields, and a repeated group", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    assert.throws(
      () => parseManifest({ ...manifest, contractVersion: "jarvis-archive-v5:1" }),
      /contractVersion must be/,
    );
    assert.throws(
      () => parseManifest({ ...manifest, surprise: 1 }),
      /unsupported field "surprise"/,
    );
    assert.throws(
      () => buildManifest({ createdAt: AT, groups: [entry("core"), entry("core")] }),
      /repeats group "core"/,
    );
  });
});

describe("archive v4 manifest — the full-recovery path refuses a partial archive", () => {
  it("refuses and names the absent groups", () => {
    const manifest = buildManifest({ createdAt: AT, groups: [entry("core"), entry("memory")] });
    assert.throws(
      () => assertRecoverable(manifest),
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /Refusing full recovery from a partial archive/.test(error.message) &&
        /businessRecords/.test(error.message),
    );
  });

  it("names an unresolved cross-group dependency in the refusal", () => {
    const withoutQuotes = ARCHIVE_GROUPS.filter((group) => group !== "quoteAggregate");
    const manifest = buildManifest({
      createdAt: AT,
      groups: withoutQuotes.map((group) => entry(group)),
      dependencies: [
        {
          from: "businessRecords",
          to: "quoteAggregate",
          reference: "invoices.quoteId -> quotes.id",
        },
      ],
    });
    assert.throws(() => assertRecoverable(manifest), /invoices\.quoteId -> quotes\.id/);
  });

  it("permits recovery only from a complete archive", () => {
    assert.doesNotThrow(() =>
      assertRecoverable(buildManifest({ createdAt: AT, groups: allGroups() })),
    );
  });

  it("today's archives are partial by construction — no group is implemented yet", () => {
    // S1 ships the gate, not coverage. Until S2-S6 land, every archive this
    // codebase can build is partial, and the recovery path must say so.
    assert.equal(buildManifest({ createdAt: AT, groups: [] }).completeness, "partial");
    assert.throws(() => assertRecoverable(buildManifest({ createdAt: AT, groups: [] })));
  });
});

describe("archive v4 manifest — group checksums", () => {
  it("is stable across key order and changes with content", () => {
    assert.equal(groupChecksum({ a: 1, b: 2 }), groupChecksum({ b: 2, a: 1 }));
    assert.notEqual(groupChecksum({ a: 1 }), groupChecksum({ a: 2 }));
  });

  it("distinguishes nested reorderings from real edits", () => {
    assert.equal(
      groupChecksum({ outer: { x: 1, y: 2 } }),
      groupChecksum({ outer: { y: 2, x: 1 } }),
    );
    assert.notEqual(groupChecksum({ outer: { x: 1 } }), groupChecksum({ outer: { x: 1, y: 2 } }));
  });
});
