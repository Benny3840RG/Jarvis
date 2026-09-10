import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARCHIVE_GROUPS,
  ArchiveManifestError,
  V4_CONTRACT_VERSION,
  VERIFICATION_METHOD,
  assertRecoverable,
  buildManifest,
  deriveCompleteness,
  groupChecksum,
  parseManifest,
  type ArchiveGroup,
  type ArchiveGroupEntry,
  type ArchiveVerification,
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

/** Evidence matching what `entry` checksums, i.e. a pass that really round-tripped. */
function verificationFor(groups: readonly ArchiveGroup[]): ArchiveVerification {
  return {
    verifiedAt: AT.toISOString(),
    method: VERIFICATION_METHOD,
    groups: groups.map((group) => ({
      group,
      restoredChecksum: groupChecksum({ group, counts: {} }),
    })),
  };
}

describe("archive v4 manifest — completeness is derived, never asserted", () => {
  it("is partial while any required group is absent", () => {
    const manifest = buildManifest({ createdAt: AT, groups: [entry("core")] });
    assert.equal(manifest.completeness, "partial");
    assert.deepEqual(manifest.coverage.present, ["core"]);
    assert.equal(manifest.coverage.absent.length, ARCHIVE_GROUPS.length - 1);
  });

  it("remains partial with every group label but no verification pass", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    assert.equal(manifest.completeness, "partial");
    assert.equal(manifest.verification, null);
  });

  it("is complete once a verification pass covers every present group", () => {
    const manifest = buildManifest({
      createdAt: AT,
      groups: allGroups(),
      verification: verificationFor(ARCHIVE_GROUPS),
    });
    assert.equal(manifest.completeness, "complete");
    assert.doesNotThrow(() => {
      assertRecoverable(manifest);
    });
  });

  it("refuses evidence whose digest is not the group's own checksum", () => {
    assert.throws(
      () =>
        buildManifest({
          createdAt: AT,
          groups: allGroups(),
          verification: {
            verifiedAt: AT.toISOString(),
            method: VERIFICATION_METHOD,
            groups: ARCHIVE_GROUPS.map((group) => ({
              group,
              restoredChecksum: groupChecksum({ group, counts: { tampered: 1 } }),
            })),
          },
        }),
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /restored data is not what was captured/.test(error.message),
    );
  });

  it("refuses evidence for a group the archive does not carry", () => {
    assert.throws(
      () =>
        buildManifest({
          createdAt: AT,
          groups: [entry("core")],
          verification: verificationFor(["core", "memory"]),
        }),
      (error: unknown) =>
        error instanceof ArchiveManifestError && /the archive does not carry/.test(error.message),
    );
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
  it("does not treat group and dependency labels as verification", () => {
    assert.equal(deriveCompleteness([], [], null), "partial");
    assert.equal(deriveCompleteness(ARCHIVE_GROUPS.slice(0, -1), [], null), "partial");
    assert.equal(deriveCompleteness([...ARCHIVE_GROUPS], [], null), "partial");
    assert.equal(
      deriveCompleteness(
        [...ARCHIVE_GROUPS],
        [{ from: "core", to: "memory", reference: "buildLogs.buildId -> builds.id" }],
        null,
      ),
      "partial",
    );
  });

  it("is complete only when every required group is both present and verified", () => {
    assert.equal(
      deriveCompleteness([...ARCHIVE_GROUPS], [], verificationFor(ARCHIVE_GROUPS)),
      "complete",
    );
  });

  it("stays partial when verification covers only some of the required groups", () => {
    assert.equal(
      deriveCompleteness([...ARCHIVE_GROUPS], [], verificationFor(ARCHIVE_GROUPS.slice(0, -1))),
      "partial",
    );
  });

  it("stays partial when a group is verified but absent from the archive", () => {
    const present = ARCHIVE_GROUPS.slice(0, -1);
    assert.equal(deriveCompleteness(present, [], verificationFor(ARCHIVE_GROUPS)), "partial");
  });

  it("stays partial when a dependency points into an absent group, however verified", () => {
    const present = ARCHIVE_GROUPS.filter((group) => group !== "quoteAggregate");
    assert.equal(
      deriveCompleteness(
        present,
        [{ from: "businessRecords", to: "quoteAggregate", reference: "invoices.quoteId" }],
        verificationFor(present),
      ),
      "partial",
    );
  });

  it("agrees with what buildManifest stamps, for every prefix of the staged order", () => {
    for (let size = 0; size <= ARCHIVE_GROUPS.length; size += 1) {
      const groups = ARCHIVE_GROUPS.slice(0, size);
      assert.equal(
        buildManifest({ createdAt: AT, groups: groups.map((group) => entry(group)) }).completeness,
        deriveCompleteness(groups, [], null),
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
      blobs: [
        { reference: "quotePdfArtifacts/a-1", digest: groupChecksum("blob bytes"), byteLength: 12 },
      ],
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

  it("rejects malformed group and blob digests", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    for (const digest of ["not-a-digest", "sha256:abc", `sha256:${"g".repeat(64)}`]) {
      assert.throws(
        () =>
          parseManifest({
            ...manifest,
            groups: allGroups().map((group) => ({ ...group, checksum: digest })),
          }),
        /checksum must be a SHA-256 digest/,
      );
      assert.throws(
        () =>
          parseManifest({
            ...manifest,
            blobs: [{ reference: "artifact/1", digest, byteLength: 1 }],
          }),
        /digest must be a SHA-256 digest/,
      );
    }
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

  it("refuses full recovery when group labels have no restore-verification evidence", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    assert.throws(() => assertRecoverable(manifest), /never been verified by an isolated restore/);
  });

  it("revalidates a mutable completeness claim at the recovery boundary", () => {
    const manifest = buildManifest({ createdAt: AT, groups: [entry("core")] });
    manifest.completeness = "complete";
    assert.throws(() => assertRecoverable(manifest), /claims "complete".*derives "partial"/);
  });

  it("cannot promote inconsistent groups and unverified reference labels to complete", () => {
    const manifest = buildManifest({
      createdAt: AT,
      groups: allGroups().map((group) => ({ ...group, consistentSnapshot: false })),
      dependencies: [{ from: "core", to: "memory", reference: "missing.id -> absent.id" }],
    });
    assert.equal(parseManifest(manifest).completeness, "partial");
    assert.throws(
      () => parseManifest({ ...manifest, completeness: "complete" }),
      /derives "partial"/,
    );
    assert.throws(() => assertRecoverable(manifest), /Refusing full recovery/);
  });

  it("today's archives are partial by construction — three groups are unimplemented", () => {
    // The verification gate is now real, so partiality has to come from the
    // remaining coverage gap rather than from a missing verifier. `core`,
    // `memory` and `businessRecords` are captured; the other three are not, so
    // even a fully verified capture of what exists is still partial — and the
    // refusal must name those groups rather than the verification.
    const implemented: ArchiveGroup[] = ["core", "memory", "businessRecords"];
    const manifest = buildManifest({
      createdAt: AT,
      groups: implemented.map((group) => entry(group)),
      verification: verificationFor(implemented),
    });
    assert.equal(manifest.completeness, "partial");
    assert.throws(
      () => {
        assertRecoverable(manifest);
      },
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /absent required group\(s\): notesAndEvidence, orchestration, quoteAggregate/.test(
          error.message,
        ) &&
        !/never been verified/.test(error.message),
    );
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

describe("archive v4 manifest — verification survives the round trip", () => {
  it("parses back a sealed manifest as complete", () => {
    const sealed = buildManifest({
      createdAt: AT,
      groups: allGroups(),
      verification: verificationFor(ARCHIVE_GROUPS),
    });
    const parsed = parseManifest(JSON.parse(JSON.stringify(sealed)));
    assert.equal(parsed.completeness, "complete");
    assert.equal(parsed.verification?.method, VERIFICATION_METHOD);
    assert.deepEqual(parsed.verification?.groups, sealed.verification?.groups);
  });

  it("treats a manifest written before verification existed as partial", () => {
    const sealed = buildManifest({ createdAt: AT, groups: allGroups() });
    const legacy = JSON.parse(JSON.stringify(sealed)) as Record<string, unknown>;
    delete legacy.verification;
    const parsed = parseManifest(legacy);
    assert.equal(parsed.verification, null);
    assert.equal(parsed.completeness, "partial");
  });

  it("refuses a manifest that claims complete on fabricated evidence", () => {
    const sealed = buildManifest({
      createdAt: AT,
      groups: allGroups(),
      verification: verificationFor(ARCHIVE_GROUPS),
    });
    const forged = JSON.parse(JSON.stringify(sealed)) as {
      verification: { groups: { group: string; restoredChecksum: string }[] };
    };
    forged.verification.groups[0].restoredChecksum = groupChecksum({ not: "the captured bytes" });
    assert.throws(
      () => parseManifest(forged),
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /restored data is not what was captured/.test(error.message),
    );
  });

  it("refuses evidence from an unknown verification method", () => {
    const sealed = buildManifest({
      createdAt: AT,
      groups: allGroups(),
      verification: verificationFor(ARCHIVE_GROUPS),
    });
    const forged = JSON.parse(JSON.stringify(sealed)) as { verification: { method: string } };
    forged.verification.method = "trust-me:1";
    assert.throws(
      () => parseManifest(forged),
      (error: unknown) =>
        error instanceof ArchiveManifestError && /verification.method must be/.test(error.message),
    );
  });

  it("names the missing verification when refusing recovery", () => {
    const manifest = buildManifest({ createdAt: AT, groups: allGroups() });
    assert.throws(
      () => {
        assertRecoverable(manifest);
      },
      (error: unknown) =>
        error instanceof ArchiveManifestError &&
        /never been verified by an isolated restore/.test(error.message) &&
        !/not implemented/.test(error.message),
    );
  });
});
