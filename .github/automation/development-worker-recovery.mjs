// Trusted observer only: no candidate code and no model-controlled recovery facts.
export async function observeUnpublishedWorker({
  get,
  repository,
  issueNumber,
  workerId,
}) {
  const match = /^github-actions:([1-9][0-9]*)$/.exec(workerId);
  if (!match)
    throw new Error("Unknown worker provenance; reconcile before retry.");
  const id = Number(match[1]);
  const run = await get(`actions/runs/${id}`);
  if (
    run.id !== id ||
    run.run_attempt !== 1 ||
    run.path !== ".github/workflows/jarvis-autobuild.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== repository ||
    run.status !== "completed" ||
    run.display_title !== `Jarvis build issue #${issueNumber}`
  )
    throw new Error(
      "Expired worker is not a completed initial build; reconcile before retry.",
    );
  const branch = `automation/issue-${issueNumber}/run-${id}`;
  const owner = repository.split("/")[0];
  const pulls = await get(
    `pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
  );
  if (
    !Array.isArray(pulls) ||
    pulls.length ||
    (await get(`git/ref/heads/${branch}`, true))
  )
    throw new Error(
      "Expired worker may have published a candidate; reconcile before retry.",
    );
}

export async function checkpointPublishedWorker({
  missions,
  get,
  repository,
  issueNumber,
  runId,
  env,
}) {
  const headSha = env.CANDIDATE_SHA || "";
  const prefix = `https://github.com/${repository}/pull/`;
  const url = env.PR_URL || "";
  const pullNumber = url.startsWith(prefix)
    ? Number(url.slice(prefix.length))
    : 0;
  let published =
    /^[a-f0-9]{40}$/.test(headSha) &&
    Number.isSafeInteger(pullNumber) &&
    pullNumber > 0;
  let observationFailed = false;
  if (published) {
    try {
      const pull = await get(`pulls/${pullNumber}`);
      published =
        pull.number === pullNumber &&
        pull.head.sha === headSha &&
        pull.head.repo?.full_name === repository &&
        pull.base.repo?.full_name === repository &&
        pull.base.ref === "main" &&
        pull.state === "open" &&
        (env.REPAIR_PR
          ? pullNumber === Number(env.REPAIR_PR) &&
            new RegExp(
              `^automation/issue-${issueNumber}/run-[1-9][0-9]*$`,
            ).test(pull.head.ref)
          : pull.head.ref === `automation/issue-${issueNumber}/run-${runId}`);
      observationFailed = !published;
    } catch {
      published = false;
      observationFailed = true;
    }
  }
  const success = env.BUILD_RESULT === "success" && published;
  await missions.checkpoint({
    subjectId: `github-development:${repository}:${issueNumber}`,
    workerId: `github-actions:${runId}`,
    runId,
    pullNumber: published ? pullNumber : 0,
    headSha: published ? headSha : "",
    success,
  });
  if (observationFailed)
    throw new Error(
      "Publication could not be bound; failed checkpoint recorded. Reconcile candidate before retry.",
    );
  return success;
}
