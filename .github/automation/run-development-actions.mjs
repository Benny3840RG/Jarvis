import {
  observeUnpublishedWorker,
  checkpointPublishedWorker,
} from "./development-worker-recovery.mjs";
import {
  DevelopmentMissions,
  convexDevelopmentClient,
  developmentMissionId,
} from "./development-missions.mjs";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { completeExistingDevelopmentMission } from "../../typescript/src/tools/runDevelopmentCompletion.ts";
import { ConvexHttpClient } from "../../typescript/node_modules/convex/dist/esm/browser/index.js";
import { FetchGitHubDevelopmentClient } from "../../typescript/src/development/githubDevelopment.ts";
const env = process.env;
const repository = env.GITHUB_REPOSITORY;
const runId = Number(env.GITHUB_RUN_ID);
const issueNumber = Number(env.ISSUE_NUMBER);
const call = convexDevelopmentClient();
const missions = new DevelopmentMissions(call);
const base = `https://api.github.com/repos/${repository}`;
async function get(path, allowMissing = false) {
  const response = await fetch(`${base}/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `GitHub observation unavailable (${response.status}): ${path}.`,
    );
  return response.json();
}
async function admit() {
  if (
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error("Only a main workflow dispatch may admit a worker.");
  if (env.GITHUB_ACTOR !== "github-actions[bot]") {
    const permission = await get(
      `collaborators/${encodeURIComponent(env.GITHUB_ACTOR)}/permission`,
    );
    if (!["admin", "maintain", "write"].includes(permission.permission))
      throw new Error("Repository writer required.");
  }
  const run = await get(`actions/runs/${runId}`);
  if (
    run.path !== ".github/workflows/jarvis-autobuild.yml" ||
    run.head_branch !== "main" ||
    run.run_attempt !== 1
  )
    throw new Error("Original trusted build workflow attempt required.");
  const main = await get("branches/main");
  const sourceSha = env.SOURCE_SHA || main.commit.sha;
  if (sourceSha !== main.commit.sha)
    throw new Error("Build source is no longer current main.");
  const issue = await get(`issues/${issueNumber}`);
  if (env.REPAIR_PR) {
    const pull = await get(`pulls/${Number(env.REPAIR_PR)}`);
    if (
      pull.head.sha !== env.REPAIR_HEAD ||
      pull.head.repo?.full_name !== repository ||
      pull.base.ref !== "main" ||
      pull.state !== "open" ||
      !new RegExp(`^automation/issue-${issueNumber}/run-[1-9][0-9]*$`).test(
        pull.head.ref,
      )
    )
      throw new Error("Repair identity mismatch.");
  }
  const binding = await missions.admit({
    observeUnpublishedWorker: (workerId) =>
      observeUnpublishedWorker({ get, repository, issueNumber, workerId }),
    repository,
    issue,
    runId,
    sourceSha,
    uncertaintyBudget: Number(
      env.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET || "NaN",
    ),
  });
  appendFileSync(
    env.GITHUB_OUTPUT,
    `subject-id=${binding.subjectId}\nworker-id=${binding.workerId}\nsource-sha=${sourceSha}\n`,
  );
  console.log(`Durable Development worker admitted: ${binding.subjectId}.`);
}
async function checkpoint() {
  const success = await checkpointPublishedWorker({
    missions,
    get,
    repository,
    issueNumber,
    runId,
    env,
  });
  console.log(
    "Durable checkpoint recorded from guarded publication observation.",
  );
  if (!success) process.exitCode = 1;
}
async function supervise() {
  const subjectId = developmentMissionId(repository, issueNumber),
    workerId = `github-actions:${runId}`;
  const checkpointRecorded = async () => {
    const events = await missions.query("developmentState:listEvents", {
      subjectId,
    });
    return events.some(
      (e) =>
        e.transitionId === "DEV_TRANSITION_BUILDING_TO_VERIFYING" &&
        e.eventType === "DEV_TRANSITION_COMMITTED" &&
        e.payload.effectPayload?.runId === runId,
    );
  };
  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    if (await checkpointRecorded()) return;
    try {
      await missions.mutate("developmentWorkerClaims:renew", {
        subjectId,
        workerId,
      });
    } catch (error) {
      if (await checkpointRecorded()) return;
      throw error;
    }
    const data = await get(`actions/runs/${runId}/jobs?per_page=100`);
    if (data.total_count > 100)
      throw new Error("Build job listing exceeds observation bound.");
    const jobs = data.jobs.filter((j) => j.name === "checkpoint");
    if (jobs.length > 1) throw new Error("Ambiguous checkpoint job.");
    if (jobs[0]?.status === "completed") {
      if (await checkpointRecorded()) return;
      throw new Error("Worker ended without a durable checkpoint.");
    }
    await sleep(60_000);
  }
  throw new Error(
    "Worker supervision deadline exceeded; lease will expire, no completion inferred.",
  );
}
async function complete() {
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const result = await missions.query("developmentState:listPage", {
      paginationOpts: { numItems: 100, cursor },
    });
    await completeSubjects(result.page);
    if (result.isDone) return;
    if (!result.continueCursor || result.continueCursor === cursor)
      throw new Error("Invalid completion cursor.");
    cursor = result.continueCursor;
  }
  throw new Error(
    "Completion sweep page budget exhausted; processed pages retained.",
  );
}
async function completeSubjects(subjects) {
  for (const subject of subjects) {
    if (subject.repository === repository && subject.state === "COMPLETE")
      await missions.mutate("developmentWorkerClaims:finalize", {
        subjectId: subject.subjectId,
      });
  }
  for (const subject of subjects)
    if (
      subject.repository === repository &&
      subject.state === "READY_TO_MERGE"
    ) {
      const result = await missions.ownerGate(subject.subjectId, (number) =>
        get(`pulls/${number}`),
      );
      console.log(
        JSON.stringify({
          subjectId: subject.subjectId,
          state: result.state,
          actionId: result.actionId,
        }),
      );
      subject.state = result.state;
    }
  if (
    !subjects.some((s) => s.repository === repository && s.state === "MERGED")
  )
    return;
  const uncertainty = Number(
    env.JARVIS_DEVELOPMENT_RESIDUAL_UNCERTAINTY || "NaN",
  );
  if (!Number.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1)
    throw new Error(
      "Explicit JARVIS_DEVELOPMENT_RESIDUAL_UNCERTAINTY required.",
    );
  if (!env.JARVIS_APPROVAL_TOKEN)
    throw new Error(
      "Missing JARVIS_APPROVAL_TOKEN for independent post-merge evidence.",
    );
  for (const subject of subjects) {
    if (subject.repository !== repository || subject.state !== "MERGED")
      continue;
    const result = await completeExistingDevelopmentMission({
      missionId: subject.subjectId,
      residualUncertainty: uncertainty,
      serviceToken: env.JARVIS_SERVICE_TOKEN,
      approvalToken: env.JARVIS_APPROVAL_TOKEN,
      client: new ConvexHttpClient(env.CONVEX_URL),
      github: new FetchGitHubDevelopmentClient(env.GH_TOKEN),
      signal: AbortSignal.timeout(60_000),
    });
    console.log(
      JSON.stringify({
        subjectId: subject.subjectId,
        status: result.status,
        evidenceId: result.evidenceId,
      }),
    );
    if (result.status !== "passed") process.exitCode = 1;
    else
      await missions.mutate("developmentWorkerClaims:finalize", {
        subjectId: subject.subjectId,
      });
  }
}
try {
  const operation = process.argv[2];
  if (operation === "admit") await admit();
  else if (operation === "checkpoint") await checkpoint();
  else if (operation === "supervise") await supervise();
  else if (operation === "complete") await complete();
  else throw new Error("Unknown Development Actions operation.");
} catch (error) {
  let message = String(error.message);
  for (const name of [
    "GH_TOKEN",
    "JARVIS_SERVICE_TOKEN",
    "JARVIS_APPROVAL_TOKEN",
  ])
    if (env[name]) message = message.split(env[name]).join("[REDACTED]");
  console.error(message);
  process.exitCode = 1;
}
