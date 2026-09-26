import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertGitHubReadOnly,
  GITHUB_READ_PLANE_TOOLS,
  GitHubWriteForbiddenError,
  isGitHubReadOnlyTool,
} from "../src/development/githubReadPlane.js";

describe("GitHub read plane safety contract (PR F)", () => {
  it("declares only read-only tools", () => {
    assert.ok(GITHUB_READ_PLANE_TOOLS.length > 0);
    for (const tool of GITHUB_READ_PLANE_TOOLS) {
      assert.equal(isGitHubReadOnlyTool(tool), true, tool);
    }
    // No duplicates in the allowlist.
    assert.equal(new Set(GITHUB_READ_PLANE_TOOLS).size, GITHUB_READ_PLANE_TOOLS.length);
  });

  it("classifies write, merge and authority tools as forbidden, and none is in the allowlist", () => {
    const forbidden = [
      "github_merge_pull_request",
      "github_create_issue",
      "github_update_pull_request",
      "github_delete_branch",
      "github_add_comment",
      "github_approve_pull_request",
      "github_submit_review",
      "github_dispatch_workflow",
      "github_create_or_update_file",
      "github_push_files",
      "merge_pull_request",
      "github_get_and_merge_pull_request",
    ];
    for (const tool of forbidden) {
      assert.equal(isGitHubReadOnlyTool(tool), false, tool);
      assert.equal(
        (GITHUB_READ_PLANE_TOOLS as readonly string[]).includes(tool),
        false,
        `${tool} must not be in the read-plane allowlist`,
      );
      assert.throws(() => assertGitHubReadOnly(tool), GitHubWriteForbiddenError, tool);
    }
  });

  it("fails closed on empty or unrecognised names", () => {
    for (const tool of ["", "github", "github_", "frobnicate_pull_request", "github_frob"]) {
      assert.equal(isGitHubReadOnlyTool(tool), false, tool);
      assert.throws(() => assertGitHubReadOnly(tool), GitHubWriteForbiddenError, tool);
    }
  });

  it("accepts plain read verbs and passes the assertion", () => {
    for (const tool of ["get_pull_request", "github_list_commits", "github_search_issues"]) {
      assert.equal(isGitHubReadOnlyTool(tool), true, tool);
      assert.doesNotThrow(() => assertGitHubReadOnly(tool), tool);
    }
  });
});
