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
  await t.run(async (ctx) => {
    const action = await ctx.db.query("toolActions").first();
    await ctx.db.patch("toolActions", action!._id, {
      state: "approved",
      approvalExpiryPolicy: "ttl",
      approvalExpiresAt: Date.now() - 1,
    });
  });
  await expect(
    bridge.ownerGate(binding.subjectId, async () => ({
      state: "open",
      head: { sha: "d".repeat(40), repo: { full_name: "o/r" } },
      base: { ref: "main", sha: "b".repeat(40) },
    })),
  ).rejects.toThrow(/terminal or expired/);
});

function recoveryFixture() {
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
      title: "Correct display",
      body: "## Acceptance criteria\n- [ ] Correct value.",
      state: "open",
      labels: ["automation-approved"],
      html_url: "https://github.com/o/r/issues/7",
    },
    runId: 1,
    sourceSha: "b".repeat(40),
    uncertaintyBudget: 0.1,
  };
  return { t, bridge, input };
}
it("expired unpublished worker is fenced and recovered through a failed checkpoint before retry", async () => {
  const { t, bridge, input } = recoveryFixture();
  const first = await bridge.admit(input);
  await t.run(async (ctx) => {
    const step = await ctx.db.query("orchestrationSteps").first();
    await ctx.db.patch("orchestrationSteps", step!._id, { leaseExpiresAt: Date.now() - 1 });
  });
  await expect(bridge.admit({ ...input, runId: 2 })).rejects.toThrow(/recovery observation/);
  let observed = "";
  const second = await bridge.admit({
    ...input,
    runId: 2,
    observeUnpublishedWorker: async (worker) => {
      observed = worker;
    },
  });
  expect(observed).toBe(first.workerId);
  expect(second.workerId).toBe("github-actions:2");
  await expect(
    bridge.checkpoint({
      ...first,
      runId: 1,
      pullNumber: 12,
      headSha: "a".repeat(40),
      success: true,
    }),
  ).rejects.toThrow();
  const steps = await t.query(api.orchestrationState.listSteps, {
    serviceToken: token,
    runId: first.subjectId,
  });
  expect(steps[0]?.attempt).toBe(2);
  expect(steps[0]?.leaseFencingToken).toBe(3);
  const events = await t.query(api.developmentState.listEvents, {
    serviceToken: token,
    subjectId: first.subjectId,
  });
  expect(events.some((e) => e.transitionId === "DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED")).toBe(
    true,
  );
  await bridge.checkpoint({
    ...second,
    runId: 2,
    pullNumber: 13,
    headSha: "c".repeat(40),
    success: true,
  });
  expect(
    (await t.query(api.developmentState.get, { serviceToken: token, subjectId: first.subjectId }))
      ?.state,
  ).toBe("VERIFYING");
});
it("publication uncertainty cannot supersede an expired worker", async () => {
  const { t, bridge, input } = recoveryFixture();
  const first = await bridge.admit(input);
  await t.run(async (ctx) => {
    const step = await ctx.db.query("orchestrationSteps").first();
    await ctx.db.patch("orchestrationSteps", step!._id, { leaseExpiresAt: Date.now() - 1 });
  });
  await expect(
    bridge.admit({
      ...input,
      runId: 2,
      observeUnpublishedWorker: async () => {
        throw new Error("publication unknown");
      },
    }),
  ).rejects.toThrow(/publication unknown/);
  const steps = await t.query(api.orchestrationState.listSteps, {
    serviceToken: token,
    runId: first.subjectId,
  });
  expect(steps[0]?.attempt).toBe(1);
  expect(steps[0]?.leaseOwner).toBe(first.workerId);
});
it("duplicate failed checkpoint cannot downgrade committed verification or disturb a newer worker", async () => {
  const { t, bridge, input } = recoveryFixture();
  const first = await bridge.admit(input);
  const checkpoint = { ...first, runId: 1, pullNumber: 12, headSha: "a".repeat(40), success: true };
  await bridge.checkpoint(checkpoint);
  await bridge.checkpoint({ ...checkpoint, success: false });
  expect(
    (await t.query(api.developmentState.get, { serviceToken: token, subjectId: first.subjectId }))
      ?.state,
  ).toBe("VERIFYING");
});
it("provenance-blocked CI leaves the checkpoint available for a trusted review", async () => {
  const { t, bridge, input } = recoveryFixture();
  const binding = await bridge.admit(input);
  await bridge.checkpoint({
    ...binding,
    runId: 1,
    pullNumber: 12,
    headSha: "a".repeat(40),
    success: true,
  });
  await bridge.review({
    repository: "o/r",
    issueNumber: 7,
    identity: {
      pullNumber: 12,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      fingerprint: "c".repeat(64),
    },
    review: { verdict: "pass" },
    ci: { ok: false, problems: ["untrusted candidate binding"], pending: [] },
    runUrl: "https://github.com/o/r/actions/runs/3",
  });
  expect(
    (await t.query(api.developmentState.get, { serviceToken: token, subjectId: binding.subjectId }))
      ?.state,
  ).toBe("VERIFYING");
});
it("completion pagination retains old subjects beyond the recent HUD snapshot", async () => {
  const { t, bridge, input } = recoveryFixture();
  await bridge.admit(input);
  await t.run(async (ctx) => {
    const subject = await ctx.db.query("developmentSubjects").first();
    const { _id, _creationTime, ...record } = subject!;
    void _id;
    void _creationTime;
    for (let i = 0; i < 104; i++)
      await ctx.db.insert("developmentSubjects", {
        ...record,
        subjectId: `other-${i}`,
        repository: "other/repo",
      });
  });
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: Array<{ subjectId: string }>; isDone: boolean; continueCursor: string } =
      await t.query(makeFunctionReference<"query">("developmentState:listPage"), {
        serviceToken: token,
        paginationOpts: { numItems: 25, cursor },
      });
    ids.push(...result.page.map((s) => s.subjectId));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(new Set(ids).size).toBe(105);
  expect(ids).toContain("github-development:o/r:7");
});
it("orchestration finalization requires both authoritative completion states and is idempotent", async () => {
  const { t, bridge, input } = recoveryFixture();
  const binding = await bridge.admit(input);
  await bridge.checkpoint({
    ...binding,
    runId: 1,
    pullNumber: 12,
    headSha: "a".repeat(40),
    success: true,
  });
  const finalize = () =>
    t.mutation(makeFunctionReference<"mutation">("developmentWorkerClaims:finalize"), {
      serviceToken: token,
      subjectId: binding.subjectId,
    });
  await expect(finalize()).rejects.toThrow();
  await t.run(async (ctx) => {
    const subject = await ctx.db.query("developmentSubjects").first();
    await ctx.db.patch("developmentSubjects", subject!._id, { state: "COMPLETE" });
  });
  await expect(finalize()).rejects.toThrow();
  await t.run(async (ctx) => {
    const mission = await ctx.db.query("omegaMissions").first();
    await ctx.db.patch("omegaMissions", mission!._id, { state: "complete" });
  });
  await finalize();
  await finalize();
  expect(
    (
      await t.query(api.orchestrationState.getRun, {
        serviceToken: token,
        runId: binding.subjectId,
      })
    )?.state,
  ).toBe("succeeded");
});
for (const success of [true, false]) {
  it(`lost checkpoint commit response safely resumes its stored ${success} result`, async () => {
    const { t, bridge, input } = recoveryFixture();
    const binding = await bridge.admit(input);
    let loseResponse = true;
    const unreliable = new DevelopmentMissions(async (kind, name, args) => {
      const result =
        kind === "query"
          ? await t.query(makeFunctionReference<"query">(name), { ...args, serviceToken: token })
          : await t.mutation(makeFunctionReference<"mutation">(name), {
              ...args,
              serviceToken: token,
            });
      if (loseResponse && name === "developmentState:commit") {
        loseResponse = false;
        throw new Error("response lost");
      }
      return result;
    });
    const checkpoint = { ...binding, runId: 1, pullNumber: 12, headSha: "a".repeat(40), success };
    await expect(unreliable.checkpoint(checkpoint)).rejects.toThrow(/response lost/);
    await t.run(async (ctx) => {
      const step = await ctx.db.query("orchestrationSteps").first();
      await ctx.db.patch("orchestrationSteps", step!._id, { leaseExpiresAt: Date.now() - 1 });
    });
    await bridge.checkpoint({ ...checkpoint, success: !success });
    await bridge.checkpoint(checkpoint);
    const steps = await t.query(api.orchestrationState.listSteps, {
      serviceToken: token,
      runId: binding.subjectId,
    });
    expect(steps[0]?.state).toBe("pending");
    expect(
      (
        await t.query(api.developmentState.get, {
          serviceToken: token,
          subjectId: binding.subjectId,
        })
      )?.state,
    ).toBe(success ? "VERIFYING" : "REPAIR_REQUIRED");
  });
}
