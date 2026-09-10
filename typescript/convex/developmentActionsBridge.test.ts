import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, expect, it, vi } from "vitest";
import { DevelopmentMissions } from "../../.github/automation/development-missions.mjs";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
const token = "development-bridge-test-service-token-000000";
afterEach(() => vi.unstubAllEnvs());
it("composes actual durable APIs through build, review, bounded repair and owner gate without claiming completion", async () => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", token);
  const t = convexTest(schema, modules);
  const bridge = new DevelopmentMissions((kind, name, args) =>
    kind === "query"
      ? t.query(makeFunctionReference<"query">(name), { ...args, serviceToken: token })
      : t.mutation(makeFunctionReference<"mutation">(name), { ...args, serviceToken: token }),
  );
  const input = {
    repository: "o/r",
    issue: {
      number: 7,
      title: "Correct the display",
      body: "## Acceptance criteria\n- [ ] The display shows the actual value.",
      state: "open",
      labels: ["automation-approved"],
      html_url: "https://github.com/o/r/issues/7",
    },
    runId: 1,
    sourceSha: "b".repeat(40),
    uncertaintyBudget: 0.1,
  };
  const binding = await bridge.admit(input);
  expect(await bridge.admit(input)).toEqual(binding);
  await expect(bridge.admit({ ...input, runId: 2 })).rejects.toThrow(
    /live Development worker lease/,
  );
  await bridge.checkpoint({
    ...binding,
    runId: 1,
    pullNumber: 12,
    headSha: "a".repeat(40),
    success: true,
  });
  const review = {
    repository: "o/r",
    issueNumber: 7,
    identity: {
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      pullNumber: 12,
      fingerprint: "c".repeat(64),
    },
    review: { verdict: "changes_requested" },
    ci: { ok: true },
    runUrl: "https://github.com/o/r/actions/runs/3",
  };
  await expect(
    bridge.review({ ...review, identity: { ...review.identity, pullNumber: 99 } }),
  ).rejects.toThrow(/PR/);
  await bridge.review(review);
  const repair = await bridge.admit({ ...input, runId: 4 });
  await bridge.checkpoint({
    ...repair,
    runId: 4,
    pullNumber: 12,
    headSha: "d".repeat(40),
    success: true,
  });
  await expect(bridge.review({ ...review, review: { verdict: "pass" } })).rejects.toThrow(/head/);
  await bridge.review({
    ...review,
    identity: { ...review.identity, headSha: "d".repeat(40) },
    review: { verdict: "pass" },
    runUrl: "https://github.com/o/r/actions/runs/5",
  });
  const gate = await bridge.ownerGate(binding.subjectId, async () => ({
    state: "open",
    head: { sha: "d".repeat(40), repo: { full_name: "o/r" } },
    base: { ref: "main", sha: "b".repeat(40) },
  }));
  expect(gate).toMatchObject({ state: "READY_TO_MERGE" });
  const actions = await t.query(api.toolActions.listRecent, {
    serviceToken: token,
    projectKey: binding.subjectId,
    limit: 10,
  });
  expect(actions).toHaveLength(1);
  expect(actions[0]?.state).toBe("proposed");
  expect(actions[0]?.approvedBy).toBeUndefined();
  const subject = await t.query(api.developmentState.get, {
    serviceToken: token,
    subjectId: binding.subjectId,
  });
  expect(subject?.state).toBe("READY_TO_MERGE");
  const mission = await t.query(
    makeFunctionReference<
      "query",
      { serviceToken: string; missionId: string },
      { state: string; acceptanceCriteria: Array<{ status: string }> } | null
    >("omegaMissions:get"),
    {
      serviceToken: token,
      missionId: binding.subjectId,
    },
  );
  expect(mission?.state).toBe("active");
  expect(mission?.acceptanceCriteria.every((c) => c.status === "unverified")).toBe(true);
});
