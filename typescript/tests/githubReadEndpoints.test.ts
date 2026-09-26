import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GITHUB_READ_PLANE_TOOLS } from "../src/development/githubReadPlane.js";
import {
  GITHUB_READ_ENDPOINT_TOOLS,
  GithubReadEndpointError,
  assertWithinRepository,
  buildGithubReadPath,
  parseGithubRepository,
} from "../src/development/githubReadEndpoints.js";

const REPO = { owner: "Benny3840RG", repo: "Jarvis" } as const;

describe("GitHub read-plane endpoint builders (PR F, auth/network hardening)", () => {
  it("parses a valid owner/repo and rejects everything else", () => {
    assert.deepEqual(parseGithubRepository("Benny3840RG/Jarvis"), REPO);
    assert.deepEqual(parseGithubRepository("  a-b/c.d_e  "), { owner: "a-b", repo: "c.d_e" });
    for (const bad of [
      undefined,
      "",
      "no-slash",
      "too/many/slashes",
      "/Jarvis",
      "owner/",
      "owner/..",
      "owner/.",
      "own er/repo",
      "owner/re po",
      "-bad/repo",
    ]) {
      assert.equal(parseGithubRepository(bad), null, JSON.stringify(bad));
    }
  });

  it("has exactly one builder per allowlisted read tool (kept in lockstep)", () => {
    assert.deepEqual([...GITHUB_READ_ENDPOINT_TOOLS].sort(), [...GITHUB_READ_PLANE_TOOLS].sort());
  });

  it("builds repository-fixed paths for each tool", () => {
    assert.equal(
      buildGithubReadPath(REPO, "github_get_pull_request", { pullNumber: 7 }),
      "/repos/Benny3840RG/Jarvis/pulls/7",
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_list_pull_request_files", { pullNumber: 7 }),
      "/repos/Benny3840RG/Jarvis/pulls/7/files",
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_list_pull_request_comments", { pullNumber: 7 }),
      "/repos/Benny3840RG/Jarvis/pulls/7/comments",
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_get_issue", { issueNumber: 42 }),
      "/repos/Benny3840RG/Jarvis/issues/42",
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_list_issues"),
      "/repos/Benny3840RG/Jarvis/issues",
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_list_commits"),
      "/repos/Benny3840RG/Jarvis/commits",
    );
    const sha = "abc1234";
    assert.equal(
      buildGithubReadPath(REPO, "github_get_commit", { ref: sha }),
      `/repos/Benny3840RG/Jarvis/commits/${sha}`,
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_get_pull_request_status", { ref: sha }),
      `/repos/Benny3840RG/Jarvis/commits/${sha}/status`,
    );
    assert.equal(
      buildGithubReadPath(REPO, "github_get_check_runs", { ref: sha }),
      `/repos/Benny3840RG/Jarvis/commits/${sha}/check-runs`,
    );
  });

  it("every built path stays within the configured repository", () => {
    for (const tool of GITHUB_READ_PLANE_TOOLS) {
      const path = buildGithubReadPath(REPO, tool, {
        pullNumber: 1,
        issueNumber: 1,
        ref: "abcdef0",
      });
      assert.ok(
        path.startsWith("/repos/Benny3840RG/Jarvis"),
        `${tool} -> ${path} must be within the repository`,
      );
    }
  });

  it("rejects missing or malformed resource ids", () => {
    // Missing / non-positive / non-integer numbers.
    for (const pullNumber of [undefined, 0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => buildGithubReadPath(REPO, "github_get_pull_request", { pullNumber }),
        GithubReadEndpointError,
        String(pullNumber),
      );
    }
    // Non-SHA refs, including traversal / slashes / branch names.
    for (const ref of [undefined, "", "main", "../../etc", "feature/x", "zzzz", "g".repeat(41)]) {
      assert.throws(
        () => buildGithubReadPath(REPO, "github_get_commit", { ref }),
        GithubReadEndpointError,
        String(ref),
      );
    }
  });

  it("assertWithinRepository rejects a path outside the repository prefix", () => {
    assertWithinRepository("/repos/Benny3840RG/Jarvis", REPO); // root is allowed
    assertWithinRepository("/repos/Benny3840RG/Jarvis/pulls/1", REPO);
    for (const path of [
      "/repos/Benny3840RG/Jarvis-evil/x",
      "/repos/other/repo/pulls/1",
      "/user",
      "/repos/Benny3840RG/JarvisX",
    ]) {
      assert.throws(() => assertWithinRepository(path, REPO), GithubReadEndpointError, path);
    }
  });
});
