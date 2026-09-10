import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { GitHubDevelopmentCompletionCoordinator } from "../development/developmentCompletion.js";
import { ConvexDevelopmentOmegaGateway } from "../development/convexDevelopmentOmegaGateway.js";
import {
  FetchGitHubDevelopmentClient,
  type GitHubDevelopmentClient,
} from "../development/githubDevelopment.js";

type DurableClient = {
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
};
const identifier = z.string().trim().min(1).max(200);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const subjectSchema = z.object({
  subjectId: identifier,
  omegaMissionId: identifier,
  state: z.literal("MERGED"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: identifier,
  lastEventId: identifier,
});
const missionSchema = z.object({
  missionId: identifier,
  state: z.enum(["active", "partial", "validating"]),
  acceptanceCriteria: z.array(z.object({ criterionId: identifier, statement: z.string() })),
});
const receiptSchema = z.object({
  receiptKey: identifier,
  projectId: identifier,
  actionId: identifier,
  status: z.literal("succeeded"),
  provider: z.literal("github-rest-v1"),
});
const actionSchema = z.object({
  actionId: identifier,
  projectKey: identifier,
  tool: z.literal("github"),
  operation: z.literal("merge-pull-request"),
  approvedBy: z.literal("user"),
  requiredAuthority: z.literal("T3"),
  destructive: z.literal(true),
  consumptionPolicy: z.literal("single-use"),
  arguments: z.object({
    subjectId: identifier,
    transitionId: z.literal("DEV_TRANSITION_READY_TO_MERGE_TO_MERGED"),
    repository: identifier,
    baseBranch: identifier,
    pullRequestNumber: z.number().int().positive().safe(),
    reviewedHeadSha: sha,
  }),
});
const eventsSchema = z.array(
  z.object({
    subjectId: identifier,
    eventId: identifier,
    eventType: z.string(),
    transitionId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  }),
);
const POST_MERGE_STATEMENT = "The merged commit exists and required post-merge CI passes.";

/**
 * Composes existing authority only. The durable MERGED event identifies the
 * executed approved action; command-line arguments cannot replace its PR/SHA.
 * This adapter supports only the already-established post-merge-ci criterion.
 */
export async function completeExistingDevelopmentMission(input: {
  missionId: string;
  residualUncertainty: number;
  serviceToken: string;
  approvalToken: string;
  client: DurableClient;
  github: GitHubDevelopmentClient;
  signal: AbortSignal;
}) {
  const missionId = identifier.parse(input.missionId);
  const uncertainty = z.number().min(0).max(1).parse(input.residualUncertainty);
  const query = async (name: string, args: Record<string, unknown>) =>
    input.client.query(makeFunctionReference<"query">(name), {
      serviceToken: input.serviceToken,
      ...args,
    });
  const subject = subjectSchema.parse(
    await query("developmentState:get", { subjectId: missionId }),
  );
  if (subject.subjectId !== missionId || subject.omegaMissionId !== missionId)
    throw new Error("Development mission binding mismatch.");
  const mission = missionSchema.parse(await query("omegaMissions:get", { missionId }));
  const criteria = mission.acceptanceCriteria.filter(
    (criterion) => criterion.criterionId === "post-merge-ci",
  );
  if (
    mission.missionId !== missionId ||
    criteria.length !== 1 ||
    criteria[0]?.statement !== POST_MERGE_STATEMENT
  ) {
    throw new Error("An existing exact post-merge-ci acceptance criterion is required.");
  }
  const events = eventsSchema.parse(
    await query("developmentState:listEvents", { subjectId: missionId }),
  );
  const candidates = events.filter((event) => event.eventId === subject.lastEventId);
  const event = candidates[0];
  if (
    candidates.length !== 1 ||
    !event ||
    event.subjectId !== missionId ||
    event.eventType !== "DEV_TRANSITION_COMMITTED" ||
    !["DEV_TRANSITION_READY_TO_MERGE_TO_MERGED", "DEV_TRANSITION_INDETERMINATE_TO_MERGED"].includes(
      event.transitionId ?? "",
    ) ||
    event.payload.to !== "MERGED"
  ) {
    throw new Error("The current durable MERGED event is required.");
  }
  const receiptKey = identifier.parse(event.payload.mergeReceiptKey);
  const receipt = receiptSchema.parse(await query("toolExecutionReceipts:get", { receiptKey }));
  if (receipt.receiptKey !== receiptKey || receipt.projectId !== missionId)
    throw new Error("Merge receipt binding mismatch.");
  const action = actionSchema.parse(
    await query("toolActions:get", { projectKey: missionId, actionId: receipt.actionId }),
  );
  if (
    action.actionId !== receipt.actionId ||
    action.projectKey !== missionId ||
    action.arguments.subjectId !== missionId ||
    action.arguments.repository !== subject.repository ||
    action.arguments.baseBranch !== subject.branch
  )
    throw new Error("Approved merge action binding mismatch.");
  input.signal.throwIfAborted();
  const gateway = new ConvexDevelopmentOmegaGateway(
    input.client,
    input.serviceToken,
    input.approvalToken,
  );
  return new GitHubDevelopmentCompletionCoordinator(
    input.github,
    gateway,
  ).observeAndRequestCompletion({
    missionId,
    repository: subject.repository,
    pullRequestNumber: action.arguments.pullRequestNumber,
    baseBranch: subject.branch,
    reviewedHeadSha: action.arguments.reviewedHeadSha,
    criterionId: criteria[0]!.criterionId,
    residualUncertainty: uncertainty,
    signal: input.signal,
  });
}

export function resolveDevelopmentCompletionConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (args.length !== 2 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(args[1] ?? "")) {
    throw new Error(
      "Usage: runDevelopmentCompletion <existing-mission-id> <explicit-residual-uncertainty-0-to-1>",
    );
  }
  const missionId = identifier.parse(args[0]);
  const deployment = /^dev:([a-z0-9-]+)$/.exec(env.CONVEX_DEPLOYMENT?.trim() ?? "");
  if (!deployment) throw new Error("Development completion requires CONVEX_DEPLOYMENT=dev:<name>.");
  const url = new URL(env.CONVEX_URL ?? "");
  if (url.href !== `https://${deployment[1]}.convex.cloud/`)
    throw new Error("CONVEX_URL must match the named development deployment.");
  const secret = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  return {
    missionId,
    residualUncertainty: Number(args[1]),
    convexUrl: url.origin,
    serviceToken: secret("JARVIS_SERVICE_TOKEN"),
    approvalToken: secret("JARVIS_APPROVAL_TOKEN"),
    githubToken: secret("JARVIS_GITHUB_TOKEN"),
  };
}

async function main() {
  const config = resolveDevelopmentCompletionConfig(process.argv.slice(2));
  const result = await completeExistingDevelopmentMission({
    ...config,
    client: new ConvexHttpClient(config.convexUrl) as unknown as DurableClient,
    github: new FetchGitHubDevelopmentClient(config.githubToken),
    signal: AbortSignal.timeout(60_000),
  });
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : "Unknown completion failure.";
    for (const name of ["JARVIS_SERVICE_TOKEN", "JARVIS_APPROVAL_TOKEN", "JARVIS_GITHUB_TOKEN"]) {
      const value = process.env[name]?.trim();
      if (value) message = message.split(value).join("[REDACTED]");
    }
    console.error(`Development completion failed: ${message}`);
    process.exitCode = 1;
  });
}
