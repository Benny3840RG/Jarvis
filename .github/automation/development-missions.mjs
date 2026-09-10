// Trusted Actions composition of existing durable authorities. No worker imports this module.
// Only main's isolated controller jobs receive the service credential.
import { createHash } from "node:crypto";
const actor = {
  actorType: "controller",
  actorId: "github-actions-development-controller",
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function developmentMissionId(repository, issueNumber) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1
  )
    throw new Error("Invalid Development issue binding.");
  // Same stable issue identity on original builds, repairs and completion sweeps.
  return `github-development:${repository}:${issueNumber}`;
}
export function convexDevelopmentClient(env = process.env, fetcher = fetch) {
  const deployment = /^dev:([a-z0-9-]+)$/.exec(env.CONVEX_DEPLOYMENT || "");
  if (!deployment || env.CONVEX_URL !== `https://${deployment[1]}.convex.cloud`)
    throw new Error(
      "Missing matching development CONVEX_DEPLOYMENT and CONVEX_URL.",
    );
  if (!env.JARVIS_SERVICE_TOKEN)
    throw new Error("Missing JARVIS_SERVICE_TOKEN.");
  return async (kind, path, args) => {
    const response = await fetcher(`${env.CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        args: { ...args, serviceToken: env.JARVIS_SERVICE_TOKEN },
        format: "json",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    // Do not relay provider errors that may echo sensitive arguments.
    if (!response.ok || result.status !== "success")
      throw new Error(`Durable operation failed: ${path}.`);
    return result.value;
  };
}
export class DevelopmentMissions {
  constructor(call) {
    this.call = call;
  }
  query(name, args) {
    return this.call("query", name, args);
  }
  mutate(name, args) {
    return this.call("mutation", name, args);
  }
  get(subjectId) {
    return this.query("developmentState:get", { subjectId });
  }
  async transition(subjectId, from, to, evidenceKey, extra = {}) {
    const subject = await this.get(subjectId);
    if (!subject) throw new Error("Durable Development subject missing.");
    const eventId = `actions:${hash([subjectId, from, to, evidenceKey])}`;
    const events = await this.query("developmentState:listEvents", {
      subjectId,
    });
    const recorded = events.find((e) => e.eventId === eventId);
    if (recorded?.eventType === "DEV_TRANSITION_COMMITTED") return subject;
    if (subject.state !== from)
      throw new Error(
        `Development state ${subject.state} cannot consume ${from} -> ${to}.`,
      );
    const result = await this.mutate("developmentState:commit", {
      subjectId,
      eventId,
      requestId: eventId,
      correlationId: subjectId,
      transitionId: `DEV_TRANSITION_${from}_TO_${to}`,
      to,
      requestedBy: actor,
      committedBy: actor,
      expectedSubjectVersion: subject.subjectVersion,
      ...(subject.lastEventId ? { causationId: subject.lastEventId } : {}),
      ...extra,
    });
    if (result.kind !== "COMMITTED")
      throw new Error(
        `Development transition refused: ${(result.reasons || []).join(", ")}.`,
      );
    return result.subject;
  }
  async admit({
    repository,
    issue,
    runId,
    sourceSha,
    uncertaintyBudget,
    observeUnpublishedWorker,
  }) {
    if (
      issue.state !== "open" ||
      issue.pull_request ||
      !issue.labels.some((l) => (l.name || l) === "automation-approved")
    )
      throw new Error("An open owner-approved issue is required.");
    if (
      !Number.isSafeInteger(runId) ||
      runId < 1 ||
      !/^[a-f0-9]{40}$/.test(sourceSha)
    )
      throw new Error("Invalid build provenance.");
    if (
      !Number.isFinite(uncertaintyBudget) ||
      uncertaintyBudget < 0 ||
      uncertaintyBudget > 1
    )
      throw new Error("Explicit Development uncertainty budget required.");
    const { validateGithubIssueSpecification } =
      await import("../../typescript/src/development/specValidation.ts");
    const [owner, repo] = repository.split("/");
    const validated = validateGithubIssueSpecification(
      {
        owner,
        repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body || "",
        labels: issue.labels.map((l) => l.name || l),
        state: issue.state,
        htmlUrl: issue.html_url,
      },
      { requiredLabels: ["automation-approved"] },
    );
    if (!validated.valid)
      throw new Error(
        `Invalid approved issue: ${validated.reasons.join(", ")}.`,
      );
    const spec = validated.specification;
    const subjectId = developmentMissionId(repository, issue.number);
    const orchestrationRunId = subjectId;
    const existing = await this.get(subjectId);
    if (!existing) {
      const begun = await this.mutate("orchestrationState:beginRun", {
        runId: orchestrationRunId,
        triggerId: `issue:${issue.number}`,
        triggerSource: "http",
        triggerKind: "github-development-mission",
        idempotencyKey: subjectId,
        requestFingerprint: spec.specHash,
        planFingerprint: spec.specHash,
        triggerPayload: {},
        authority: "T2",
        policyVersion: "development-policy:v1",
        policyFingerprint: "development-policy-fingerprint:v1",
        nodeIds: ["development-worker"],
        maxRetries: 2,
      });
      if (begun.status === "conflict")
        throw new Error(
          "Issue specification changed during mission admission.",
        );
      const mission = await this.query("omegaMissions:get", {
        missionId: subjectId,
      });
      if (!mission)
        await this.mutate("omegaMissions:create", {
          missionId: subjectId,
          projectKey: subjectId,
          objective: spec.objective,
          riskClass: "R3",
          autonomyClass: "A2",
          reversibilityClass: "REV-2",
          uncertaintyBudget,
          acceptanceCriteria: [
            ...spec.acceptanceCriteria.map((statement, i) => ({
              criterionId: `issue-${i + 1}`,
              statement,
              status: "unverified",
              evidenceRefs: [],
            })),
            {
              criterionId: "post-merge-ci",
              statement:
                "The merged commit exists and required post-merge CI passes.",
              status: "unverified",
              evidenceRefs: [],
            },
          ],
        });
      await this.mutate("developmentState:create", {
        subjectId,
        orchestrationRunId,
        orchestrationNodeId: "development-worker",
        repository,
        branch: "main",
      });
    }
    // The immutable run fingerprint also prevents a repaired issue from silently changing scope.
    const run = await this.query("orchestrationState:getRun", {
      runId: orchestrationRunId,
    });
    if (run.requestFingerprint !== spec.specHash)
      throw new Error(
        "Approved issue specification differs from the durable mission.",
      );
    let subject = await this.get(subjectId);
    if (subject.state === "IDEA")
      subject = await this.transition(
        subjectId,
        "IDEA",
        "SPECIFIED",
        spec.specHash,
        {
          effectPayload: {
            specHash: spec.specHash,
            issueUrl: issue.html_url,
            sourceSha,
          },
        },
      );
    if (subject.state === "SPECIFIED")
      subject = await this.transition(
        subjectId,
        "SPECIFIED",
        "READY",
        spec.specHash,
      );
    const mission = await this.query("omegaMissions:get", {
      missionId: subjectId,
    });
    if (mission.state === "initializing")
      await this.mutate("omegaMissions:transition", {
        missionId: subjectId,
        nextState: "active",
      });
    if (["CLAIMED", "BUILDING"].includes(subject.state)) {
      const workerId = `github-actions:${runId}`;
      const existingSteps = await this.query("orchestrationState:listSteps", {
        runId: orchestrationRunId,
      });
      const old = existingSteps.find((s) => s.nodeId === "development-worker");
      if (old?.state === "running" && old.leaseExpiresAt <= Date.now()) {
        if (!observeUnpublishedWorker)
          throw new Error("Independent recovery observation required.");
        await observeUnpublishedWorker(old.leaseOwner);
        const lease = await this.mutate(
          "developmentWorkerClaims:recoverExpired",
          {
            subjectId,
            workerId,
            previousWorkerId: old.leaseOwner,
            expectedFencingToken: old.leaseFencingToken,
          },
        );
        if (subject.state === "CLAIMED")
          await this.transition(
            subjectId,
            "CLAIMED",
            "BUILDING",
            `recovery:${runId}`,
            { workerId, lease },
          );
        await this.checkpoint({
          subjectId,
          workerId,
          runId: Number(old.leaseOwner.split(":")[1]),
          pullNumber: 0,
          headSha: "",
          success: false,
        });
        subject = await this.get(subjectId);
      } else {
        const lease = await this.query("developmentWorkerClaims:get", {
          subjectId,
          workerId,
        });
        if (subject.state === "CLAIMED")
          await this.transition(subjectId, "CLAIMED", "BUILDING", runId, {
            workerId,
            lease,
            effectPayload: { runId, sourceSha },
          });
        return { subjectId, workerId };
      }
    }
    if (subject.state === "REPAIR_REQUIRED") {
      const events = await this.query("developmentState:listEvents", {
        subjectId,
      });
      const checkpoint = [...events]
        .reverse()
        .find(
          (e) =>
            e.transitionId === "DEV_TRANSITION_BUILDING_TO_VERIFYING" &&
            e.eventType === "DEV_TRANSITION_COMMITTED",
        );
      if (!checkpoint?.payload.effectPayload?.headSha) {
        if (!observeUnpublishedWorker)
          throw new Error(
            "Independent recovery observation required before retrying an unbound publication.",
          );
        await observeUnpublishedWorker(
          `github-actions:${checkpoint?.payload.effectPayload?.runId}`,
        );
      }
    }
    const steps = await this.query("orchestrationState:listSteps", {
      runId: orchestrationRunId,
    });
    const step = steps.find((s) => s.nodeId === "development-worker");
    if (!step || step.attempt >= 3)
      throw new Error("Durable worker attempt budget exhausted.");
    if (!["READY", "REPAIR_REQUIRED"].includes(subject.state))
      throw new Error(
        `Mission is not available for a new worker: ${subject.state}.`,
      );
    const workerId = `github-actions:${runId}`;
    const grant =
      step.state === "running"
        ? {
            step,
            ...(await this.query("developmentWorkerClaims:get", {
              subjectId,
              workerId,
            })),
          }
        : await this.mutate("orchestrationState:markStepRunning", {
            runId: orchestrationRunId,
            nodeId: "development-worker",
            operationId: "github-development-worker",
            workerId,
            leaseTtlMs: 15 * 60_000,
          });
    const lease = {
      leaseToken: grant.leaseToken,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(grant.step.leaseExpiresAt).toISOString(),
      fencingToken: grant.fencingToken,
    };
    const extra = { workerId, lease, effectPayload: { runId, sourceSha } };
    if (subject.state === "READY") {
      await this.transition(subjectId, "READY", "CLAIMED", runId, extra);
      await this.transition(subjectId, "CLAIMED", "BUILDING", runId, extra);
    } else
      await this.transition(
        subjectId,
        "REPAIR_REQUIRED",
        "BUILDING",
        runId,
        extra,
      );
    return { subjectId, workerId };
  }
  async checkpoint({
    subjectId,
    workerId,
    runId,
    pullNumber,
    headSha,
    success,
  }) {
    const subject = await this.get(subjectId);
    if (subject.state === "BUILDING") {
      const lease = await this.query("developmentWorkerClaims:get", {
        subjectId,
        workerId,
      });
      await this.transition(subjectId, "BUILDING", "VERIFYING", runId, {
        workerId,
        lease,
        effectPayload: {
          runId,
          pullNumber: pullNumber || 0,
          headSha: headSha || "",
          workerSucceeded: success,
        },
      });
    }
    const events = await this.query("developmentState:listEvents", {
      subjectId,
    });
    const checkpoint = [...events]
      .reverse()
      .find(
        (e) =>
          e.eventType === "DEV_TRANSITION_COMMITTED" &&
          e.transitionId === "DEV_TRANSITION_BUILDING_TO_VERIFYING",
      );
    if (
      checkpoint?.payload.effectPayload?.runId !== runId ||
      checkpoint.requestedBy?.actorId !== workerId
    )
      throw new Error("Checkpoint replay is not bound to the current worker.");
    // Use the durable result, never a rerun's missing or contradictory outputs.
    if (
      checkpoint.payload.effectPayload.workerSucceeded === false &&
      (await this.get(subjectId)).state === "VERIFYING"
    )
      await this.transition(
        subjectId,
        "VERIFYING",
        "REPAIR_REQUIRED",
        `worker-failed:${runId}`,
      );
    await this.mutate("developmentWorkerClaims:pause", {
      subjectId,
      workerId,
      checkpointEventId: checkpoint.eventId,
    });
  }
  async review({ repository, issueNumber, identity, review, ci, runUrl }) {
    const subjectId = developmentMissionId(repository, issueNumber);
    const subject = await this.get(subjectId);
    if (!subject)
      throw new Error(
        "Generated candidate lacks a durable Development mission.",
      );
    if (
      !["VERIFYING", "REVIEW", "REPAIR_REQUIRED", "READY_TO_MERGE"].includes(
        subject.state,
      )
    )
      throw new Error("Worker checkpoint has not been committed.");
    // Missing/untrusted evidence is not an application defect. A new trusted
    // snapshot can be reviewed without stranding the subject in repair.
    if (
      !ci.ok &&
      ((ci.pending || []).length ||
        (ci.problems || []).some((problem) =>
          /untrusted|binding|invalid|incomplete/i.test(problem),
        ))
    )
      return;
    const key = `${identity.headSha}:${identity.fingerprint}:${runUrl}`;
    const effectPayload = {
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      pullNumber: identity.pullNumber,
      runUrl,
      ciFingerprint: identity.fingerprint,
    };
    const events = await this.query("developmentState:listEvents", {
      subjectId,
    });
    const checkpoint = [...events]
      .reverse()
      .find(
        (e) =>
          e.transitionId === "DEV_TRANSITION_BUILDING_TO_VERIFYING" &&
          e.eventType === "DEV_TRANSITION_COMMITTED",
      );
    if (
      checkpoint?.payload.effectPayload?.headSha !== identity.headSha ||
      checkpoint?.payload.effectPayload?.pullNumber !== identity.pullNumber
    )
      throw new Error(
        "Review head or PR does not match the durable worker checkpoint.",
      );
    if (["READY_TO_MERGE", "REPAIR_REQUIRED"].includes(subject.state)) {
      // No synthetic transition or new approval from a replay/superseding observation.
      // Generated ToolActions bind base+CI fingerprint and recheck them at preflight.
      if (
        subject.state === "READY_TO_MERGE" &&
        (!ci.ok || review.verdict !== "pass")
      )
        throw new Error(
          "Ready candidate evidence changed; owner action must not execute without fresh evidence.",
        );
      return;
    }
    if (!ci.ok) {
      if (subject.state === "VERIFYING")
        await this.transition(subjectId, "VERIFYING", "REPAIR_REQUIRED", key, {
          effectPayload,
        });
      return;
    }
    if (subject.state === "VERIFYING")
      await this.transition(subjectId, "VERIFYING", "REVIEW", key, {
        effectPayload,
        verificationEvidence: {
          checksPassed: true,
          hasBlockingFindings: false,
          receiptId: runUrl,
        },
      });
    if (review.verdict === "blocked") return;
    const to = review.verdict === "pass" ? "READY_TO_MERGE" : "REPAIR_REQUIRED";
    await this.transition(subjectId, "REVIEW", to, key, {
      effectPayload,
      reviewEvidence: {
        reviewComplete: true,
        hasBlockingFindings: to === "REPAIR_REQUIRED",
        receiptId: runUrl,
      },
    });
  }
  async ownerGate(subjectId, observePull) {
    const subject = await this.get(subjectId);
    if (subject?.state !== "READY_TO_MERGE") return subject;
    const events = await this.query("developmentState:listEvents", {
      subjectId,
    });
    const latest = events.find((e) => e.eventId === subject.lastEventId);
    const binding = latest?.payload.effectPayload;
    if (
      !binding?.headSha ||
      !binding.pullNumber ||
      latest.transitionId !== "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE"
    )
      throw new Error(
        "Exact durable reviewed candidate is required for owner gate.",
      );
    const pull = await observePull(binding.pullNumber);
    if (
      pull.head.sha !== binding.headSha ||
      pull.head.repo?.full_name !== subject.repository ||
      pull.base.ref !== subject.branch ||
      (!pull.merged && pull.base.sha !== binding.baseSha)
    )
      throw new Error(
        "Owner gate candidate no longer matches the durable review.",
      );
    const actionId = `development-merge:${hash([subjectId, binding.pullNumber, binding.headSha, binding.baseSha, binding.ciFingerprint])}`;
    let action = await this.query("toolActions:get", {
      projectKey: subjectId,
      actionId,
    });
    if (!action) {
      if (pull.state !== "open")
        throw new Error(
          "Cannot manufacture approval for an already-closed PR.",
        );
      let project = await this.query("projects:get", { projectKey: subjectId });
      if (!project) {
        const now = new Date().toISOString();
        project = await this.mutate("projects:upsert", {
          projectKey: subjectId,
          projectName: `Development ${subjectId}`,
          projectType: "development",
          status: "active",
          createdAt: now,
          updatedAt: now,
          revision: 1,
          domains: ["development"],
          summary: `Owner-gated development for ${subject.repository}.`,
          preferences: {
            outputStyle: "concise",
            communicationTone: "direct",
            detailLevel: "normal",
            unitSystem: "metric",
            locale: "en-AU",
          },
        });
      }
      const { computeAuthorityEnvelopeHash } =
        await import("../../typescript/src/development/stateMachine.ts");
      const run = await this.query("orchestrationState:getRun", {
        runId: subject.orchestrationRunId,
      });
      action = await this.mutate("toolActions:stage", {
        actionId,
        requestId: actionId,
        projectKey: subjectId,
        expectedRevision: project.revision,
        tool: "github",
        operation: "merge-pull-request",
        arguments: {
          subjectId,
          transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
          repository: subject.repository,
          baseBranch: subject.branch,
          pullRequestNumber: binding.pullNumber,
          reviewedHeadSha: binding.headSha,
          reviewedBaseSha: binding.baseSha,
          candidateEvidenceFingerprint: binding.ciFingerprint,
          mergeMethod: "squash",
          authorityEnvelopeHash: computeAuthorityEnvelopeHash({
            repositories: [subject.repository],
            branches: [subject.branch],
            externalEffects: ["github.merge"],
            maxRiskClass: Number(run.authority.slice(1)),
          }),
          policyDecisionFingerprint: run.policyFingerprint,
          effectiveRisk: 4,
        },
        rationale: `Owner approval required for independently reviewed PR #${binding.pullNumber} at ${binding.headSha}.`,
        requiredAuthority: "T3",
        destructive: true,
        idempotencyKey: actionId,
        proposedBy: "agent",
      });
    }
    const requireLiveProposal = () => {
      if (
        ["rejected", "revoked", "expired"].includes(action.state) ||
        action.isApprovalExpired
      )
        throw new Error(
          "Owner merge proposal is terminal or expired; explicit owner reconciliation is required. No replacement approval inferred.",
        );
    };
    // Reconcile succeeded effects even if their former approval TTL has elapsed.
    if (!action.singleUseClaimId) {
      requireLiveProposal();
      return { state: "READY_TO_MERGE", subjectId, actionId };
    }
    const { fingerprintToolEffect } =
      await import("../../typescript/src/actions/toolExecution.ts");
    const envelope = await this.query("externalReconciliations:getByScope", {
      projectId: subjectId,
      tool: "github",
      operation: "merge-pull-request",
      idempotencyKey: action.singleUseClaimId,
      effectFingerprint: fingerprintToolEffect({
        ...action,
        projectId: subjectId,
      }),
    });
    if (envelope?.receipt?.status !== "succeeded") {
      requireLiveProposal();
      return { state: "READY_TO_MERGE", subjectId, actionId };
    }
    return this.transition(
      subjectId,
      "READY_TO_MERGE",
      "MERGED",
      envelope.reconciliation.receiptKey,
      { mergeReceiptKey: envelope.reconciliation.receiptKey },
    );
  }
}
