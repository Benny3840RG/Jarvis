import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { resolveOutlookConnections } from "../auth/microsoftOutlookConnections.js";
import {
  createMicrosoftOutlookRuntimeFromEnv,
  type MicrosoftOutlookRuntime,
} from "../auth/microsoftOutlookRuntime.js";
import { api } from "../../convex/_generated/api.js";
import { createOutlookReconciliationWorker } from "../reconciliation/outlookRuntimeReconciliation.js";
import {
  resolveRuntimeReconciliationConfig,
  type EnabledRuntimeReconciliationConfig,
} from "../reconciliation/runtimeReconciliationHost.js";
import { ReconciliationWorker } from "../reconciliation/reconciliationWorker.js";
import {
  assessBeezTreezWorkflow,
  finishBeezTreezWorkflow,
  startBeezTreezWorkflow,
  type WorkflowCall,
  type WorkflowChecks,
  type WorkflowFinish,
  type WorkflowStart,
} from "./beezTreezWorkflow.js";
import {
  assertOutlookCommissioningProof,
  beginOutlookQuoteCommissioning,
  normaliseCommissioningEnvironment,
  type CommissioningEnvironment,
  type CommissioningPlan,
  type OutlookCommissioningEvidence,
  type ReconciliationObservation,
} from "./outlookQuoteCommissioningGuard.js";

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export type CommissioningRequest = (input: {
  baseUrl: string;
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: Json;
}) => Promise<{ status: number; body: Json }>;

async function requestJson(input: {
  baseUrl: string;
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: Json;
}): Promise<{ status: number; body: Json }> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as Json };
  } catch {
    return { status: response.status, body: text.slice(0, 200) };
  }
}

function expectStatus(
  response: { status: number; body: Json },
  expected: number,
  step: string,
): Json {
  if (response.status === expected) return response.body;
  const detail =
    isRecord(response.body) && typeof response.body.detail === "string" ? response.body.detail : "";
  throw new Error(`${step} returned ${response.status}. ${detail}`.trim());
}

function readSnapshot(body: Json): {
  quoteId: string;
  aggregateVersion: number;
  revision: number;
  revisionVersion: number;
  status: string;
  fingerprint?: string;
  projectId?: string;
} {
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error("Quote response did not include data.");
  }
  const aggregate = body.data.aggregate;
  const revision = body.data.revision;
  if (!isRecord(aggregate) || !isRecord(revision)) {
    throw new Error("Quote response did not include aggregate and revision.");
  }
  const quoteId = aggregate.quoteId;
  const aggregateVersion = aggregate.aggregateVersion;
  const revisionNumber = revision.revision;
  const revisionVersion = revision.revisionVersion;
  const status = revision.status;
  if (
    typeof quoteId !== "string" ||
    typeof aggregateVersion !== "number" ||
    typeof revisionNumber !== "number" ||
    typeof revisionVersion !== "number" ||
    typeof status !== "string"
  ) {
    throw new Error("Quote response was missing revision coordinates.");
  }
  const fingerprint = revision.fingerprint;
  const projectId = aggregate.projectId;
  return {
    quoteId,
    aggregateVersion,
    revision: revisionNumber,
    revisionVersion,
    status,
    ...(typeof fingerprint === "string" ? { fingerprint } : {}),
    ...(typeof projectId === "string" ? { projectId } : {}),
  };
}

function envelope(snapshot: { aggregateVersion: number; revisionVersion: number }): {
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
} {
  return {
    expectedAggregateVersion: snapshot.aggregateVersion,
    expectedRevisionVersion: snapshot.revisionVersion,
  };
}

function readReceipt(body: Json): {
  status: string;
  providerRequestId?: string;
  reconciliationId?: string;
} {
  if (!isRecord(body) || typeof body.status !== "string") {
    throw new Error("Tool execution did not return a receipt.");
  }
  return {
    status: body.status,
    ...(typeof body.providerRequestId === "string"
      ? { providerRequestId: body.providerRequestId }
      : {}),
    ...(typeof body.reconciliationId === "string"
      ? { reconciliationId: body.reconciliationId }
      : {}),
  };
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" || typeof field === "number") out[key] = field;
  }
  return out;
}

export type CommissioningWorkerRun = {
  workerId: string;
  result: { status: string; [key: string]: unknown };
};

export type CommissioningTrace = {
  /** The repeat send's own receipt as the execute route returned it (#866 gap 4). */
  repeatSend: Record<string, unknown> | null;
  /** Each delivery attempt's status and timestamps, without the recipient (gap 2). */
  deliveries: Record<string, unknown>[];
  /** The reconciliation's attempt history (gap 2). */
  reconciliation: Record<string, unknown> | null;
  /**
   * True when the reconciliation first saw the message still as a draft and then
   * resolved it as sent under the same Graph id as the delivery. Behavioural
   * evidence that the id was immutable across the move to Sent Items (gap 1);
   * it is not a trace of the request header.
   */
  sameMessageIdDraftToSent: boolean;
  /**
   * True only when this delivery's ledger history records Graph confirming
   * `Preference-Applied: IdType="ImmutableId"` on draft creation (gap 1).
   */
  draftImmutableIdApplied: boolean;
  /** Every sequential and parallel worker run, in order (gap 3). */
  workers: CommissioningWorkerRun[];
  /** True when the parallel pair ran first, before any worker had resolved the work (gap 3). */
  parallelRaceBeforeResolution: boolean;
  /** Worker runs that resolved a record; more than one would be a duplicate terminal effect. */
  resolvedWorkerRuns: number;
};

const TRANSITION_EVENTS = new Set([
  "pending",
  "executing",
  "provider-reference",
  "indeterminate",
  "succeeded",
  "failed",
  "reconciled",
]);

function transitionsFrom(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.event !== "string" || !TRANSITION_EVENTS.has(entry.event))
      return [];
    if (typeof entry.at !== "number") return [];
    return [
      {
        event: entry.event,
        at: entry.at,
        ...(typeof entry.immutableIdApplied === "boolean"
          ? { immutableIdApplied: entry.immutableIdApplied }
          : {}),
      },
    ];
  });
}

export type CommissioningRunEvidence = OutlookCommissioningEvidence & {
  quoteId: string;
  revision: number;
  recipient: string;
  trace: CommissioningTrace;
  /** Present only in workflow mode: the end-to-end Beez Treez chain around the send. */
  workflow?: BeezTreezWorkflowEvidence;
};

export type BeezTreezWorkflowEvidence = {
  clientId: string;
  propertyId: string;
  enquiryId: string;
  projectId: string;
  quoteId: string;
  invoiceId: string;
  briefBefore: WorkflowStart["briefBefore"];
  briefAfter: WorkflowFinish["briefAfter"];
  hud: WorkflowFinish["hud"];
  checks: WorkflowChecks;
  proven: boolean;
};

/** Collects the facts the owner decision card asks for from responses the kit already has. */
export function commissioningTrace(input: {
  repeatReceipt: Json;
  deliveries: Json;
  reconciliationDetail: Json;
  workers: readonly CommissioningWorkerRun[];
}): CommissioningTrace {
  const repeatSend = pick(input.repeatReceipt, [
    "receiptId",
    "status",
    "errorCode",
    "startedAt",
    "completedAt",
  ]);
  const listed =
    isRecord(input.deliveries) && Array.isArray(input.deliveries.data) ? input.deliveries.data : [];
  const deliveries = listed
    .map((entry) => {
      const picked = pick(entry, [
        "deliveryAttemptId",
        "status",
        "reconciledOutcome",
        "providerRequestId",
        "createdAt",
        "executionStartedAt",
        "reconciledAt",
      ]);
      const transitions = transitionsFrom(isRecord(entry) ? entry.transitions : undefined);
      return picked && transitions ? { ...picked, transitions } : picked;
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const reconciliation = pick(
    isRecord(input.reconciliationDetail) ? input.reconciliationDetail.reconciliation : null,
    [
      "reconciliationId",
      "providerRequestId",
      "state",
      "terminalStatus",
      "attemptCount",
      "lastErrorCode",
      "createdAt",
      "resolvedAt",
    ],
  );
  const messageId = reconciliation?.providerRequestId;
  const sameMessageIdDraftToSent =
    reconciliation !== null &&
    typeof messageId === "string" &&
    reconciliation.state === "resolved" &&
    reconciliation.terminalStatus === "succeeded" &&
    reconciliation.lastErrorCode === "outlook-message-still-draft" &&
    typeof reconciliation.attemptCount === "number" &&
    reconciliation.attemptCount >= 2 &&
    deliveries.some((entry) => entry.providerRequestId === messageId);
  const draftImmutableIdApplied =
    typeof messageId === "string" &&
    deliveries.some(
      (entry) =>
        entry.providerRequestId === messageId &&
        Array.isArray(entry.transitions) &&
        (entry.transitions as Record<string, unknown>[]).some(
          (step) => step.event === "provider-reference" && step.immutableIdApplied === true,
        ),
    );
  const workers = [...input.workers];
  // The pair must be the first runs (so nothing had resolved the work yet), and at
  // least one of them must have claimed it; two idle runs prove no race at all.
  const firstPair = workers.slice(0, 2);
  const parallelRaceBeforeResolution =
    firstPair.length === 2 &&
    firstPair.every((run) => /-par-[ab]$/.test(run.workerId)) &&
    firstPair.some((run) => run.result.status !== "idle");
  return {
    repeatSend: repeatSend && Object.keys(repeatSend).length > 0 ? repeatSend : null,
    deliveries,
    reconciliation:
      reconciliation && Object.keys(reconciliation).length > 0 ? reconciliation : null,
    sameMessageIdDraftToSent,
    draftImmutableIdApplied,
    workers,
    parallelRaceBeforeResolution,
    resolvedWorkerRuns: workers.filter((run) => run.result.status === "resolved").length,
  };
}

function observationFrom(value: unknown): ReconciliationObservation | null {
  if (
    !isRecord(value) ||
    typeof value.reconciliationId !== "string" ||
    typeof value.state !== "string"
  ) {
    return null;
  }
  return {
    reconciliationId: value.reconciliationId,
    state: value.state,
    ...(typeof value.providerRequestId === "string"
      ? { providerRequestId: value.providerRequestId }
      : {}),
    ...(typeof value.terminalStatus === "string" ? { terminalStatus: value.terminalStatus } : {}),
  };
}

/**
 * Named mode must stage the exact sender fingerprint. Legacy mode omits it.
 * There is no default connection when more than one mailbox is configured.
 */
export function commissioningSenderConnection(
  environment: CommissioningEnvironment,
): string | undefined {
  const named =
    environment.JARVIS_OUTLOOK_ENABLED === "true" &&
    environment.JARVIS_OUTLOOK_CONNECTIONS_JSON !== undefined;
  const selected = environment.JARVIS_OUTLOOK_COMMISSIONING_CONNECTION?.trim() ?? "";
  if (!named) {
    if (selected.length > 0) {
      throw new Error(
        "Outlook quote commissioning refused: JARVIS_OUTLOOK_COMMISSIONING_CONNECTION is only valid when named Outlook connections are enabled.",
      );
    }
    return undefined;
  }
  if (selected.length === 0) {
    throw new Error(
      "Outlook quote commissioning refused: JARVIS_OUTLOOK_COMMISSIONING_CONNECTION must name the sender connection.",
    );
  }
  let connections;
  try {
    connections = resolveOutlookConnections(environment);
  } catch {
    throw new Error(
      "Outlook quote commissioning refused: named Outlook connections could not be read.",
    );
  }
  const match = connections.filter((connection) => connection.id === selected);
  const chosen = match[0];
  if (match.length !== 1 || !chosen) {
    throw new Error(
      "Outlook quote commissioning refused: JARVIS_OUTLOOK_COMMISSIONING_CONNECTION must name one configured connection.",
    );
  }
  return chosen.senderConnection;
}

async function loadContacts(
  request: CommissioningRequest,
  baseUrl: string,
  token: string,
): Promise<string[]> {
  const body = expectStatus(
    await request({ baseUrl, token, method: "GET", path: "/api/v1/clients" }),
    200,
    "List clients",
  );
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Client list did not include data.");
  }
  const values: string[] = [];
  for (const client of body.data) {
    if (!isRecord(client) || !Array.isArray(client.contacts)) continue;
    for (const contact of client.contacts) {
      if (isRecord(contact) && typeof contact.value === "string") values.push(contact.value);
    }
  }
  return values;
}

/**
 * The guard stores the Convex URL as `URL.toString()`, which ends in `/`. The Convex client
 * appends `/api/query`, so a trailing slash would produce `//api/query` (a 404 with an empty body).
 */
export async function projectRevision(
  plan: Pick<CommissioningPlan, "convexUrl" | "projectKey">,
  serviceToken: string,
  fetchImplementation?: typeof globalThis.fetch,
): Promise<number | null> {
  const address = plan.convexUrl.replace(/\/+$/u, "");
  const client = new ConvexHttpClient(
    address,
    fetchImplementation ? { fetch: fetchImplementation } : undefined,
  );
  const project = await client.query(api.projects.get, {
    serviceToken,
    projectKey: plan.projectKey,
  });
  if (project === null) return null;
  return project.revision;
}

function requireProject(revision: number | null): number {
  if (revision === null) {
    throw new Error(
      "Outlook quote commissioning refused: the totality project does not exist. This kit does not create one.",
    );
  }
  return revision;
}

async function stageSend(input: {
  request: CommissioningRequest;
  plan: CommissioningPlan;
  token: string;
  approvalToken: string;
  projectRevision: number;
  actionId: string;
  quoteId: string;
  fingerprint: string;
}): Promise<void> {
  const staged = expectStatus(
    await input.request({
      baseUrl: input.plan.apiBaseUrl,
      token: input.token,
      method: "POST",
      path: `/api/v1/projects/${encodeURIComponent(input.plan.projectKey)}/tool-actions`,
      body: {
        actionId: input.actionId,
        expectedRevision: input.projectRevision,
        tool: "quotes",
        operation: "send",
        arguments: {
          quoteId: input.quoteId,
          quoteRevision: 1,
          recipient: input.plan.recipient,
          deliveryChannel: "email",
          expectedRevisionFingerprint: input.fingerprint,
          ...(input.plan.senderConnection === undefined
            ? {}
            : { senderConnection: input.plan.senderConnection }),
        },
        rationale: "Commissioning send of a disposable non-customer quote.",
        requiredAuthority: "T2",
        destructive: false,
        idempotencyKey: input.actionId,
        proposedBy: "user",
      },
    }),
    201,
    "Stage quotes:send",
  );
  if (!isRecord(staged) || staged.baseRevision !== input.projectRevision) {
    throw new Error("Staged quotes:send did not bind the totality project revision.");
  }
  const approved = expectStatus(
    await input.request({
      baseUrl: input.plan.apiBaseUrl,
      token: input.token,
      method: "POST",
      path: `/api/v1/projects/${encodeURIComponent(input.plan.projectKey)}/tool-actions/${encodeURIComponent(input.actionId)}/approve`,
      body: {
        expectedRevision: input.projectRevision,
        approvalToken: input.approvalToken,
      },
    }),
    200,
    "Approve quotes:send",
  );
  if (!isRecord(approved) || approved.state !== "approved") {
    throw new Error("quotes:send did not reach approved.");
  }
}

async function executeSend(input: {
  request: CommissioningRequest;
  plan: CommissioningPlan;
  token: string;
  actionId: string;
}): Promise<{
  status: string;
  providerRequestId?: string;
  reconciliationId?: string;
  body: Json;
}> {
  const body = expectStatus(
    await input.request({
      baseUrl: input.plan.apiBaseUrl,
      token: input.token,
      method: "POST",
      path: `/api/v1/projects/${encodeURIComponent(input.plan.projectKey)}/tool-actions/${encodeURIComponent(input.actionId)}/execute`,
      body: { idempotencyKey: input.actionId },
    }),
    200,
    "Execute quotes:send",
  );
  return { ...readReceipt(body), body };
}

export async function drainWorker(
  worker: Pick<ReconciliationWorker, "runOnce">,
  marker: string,
  runs: CommissioningWorkerRun[],
): Promise<void> {
  const signal = AbortSignal.timeout(20_000);
  // Two workers race first, while the work is still unresolved, so the trace shows
  // whether they can produce duplicate terminal records (#866 gap 3).
  const parallel = [`${marker}-par-a`, `${marker}-par-b`];
  const results = await Promise.all(
    parallel.map((workerId) => worker.runOnce({ workerId, leaseMs: 10_000, signal })),
  );
  parallel.forEach((workerId, index) => {
    const result = results[index];
    if (result) runs.push({ workerId, result });
  });
  // Sequential runs then finish any work the race released or left due.
  for (let index = 0; index < 3; index += 1) {
    const workerId = `${marker}-seq-${index}`;
    runs.push({ workerId, result: await worker.runOnce({ workerId, leaseMs: 10_000, signal }) });
  }
}

async function readReconciliations(input: {
  request: CommissioningRequest;
  plan: CommissioningPlan;
  token: string;
  reconciliationId: string;
}): Promise<ReconciliationObservation[]> {
  const listed = expectStatus(
    await input.request({
      baseUrl: input.plan.apiBaseUrl,
      token: input.token,
      method: "GET",
      path: "/api/v1/reconciliations?limit=100",
    }),
    200,
    "List reconciliations",
  );
  const records: ReconciliationObservation[] = [];
  if (isRecord(listed) && Array.isArray(listed.data)) {
    for (const entry of listed.data) {
      const observed = observationFrom(entry);
      if (observed) records.push(observed);
    }
  }
  const detail = expectStatus(
    await input.request({
      baseUrl: input.plan.apiBaseUrl,
      token: input.token,
      method: "GET",
      path: `/api/v1/reconciliations/${encodeURIComponent(input.reconciliationId)}`,
    }),
    200,
    "Get reconciliation",
  );
  const focused = observationFrom(isRecord(detail) ? detail.reconciliation : null);
  if (focused && !records.some((record) => record.reconciliationId === focused.reconciliationId)) {
    records.push(focused);
  }
  return records;
}

async function runCommissioning(input: {
  request: CommissioningRequest;
  environment: CommissioningEnvironment;
  plan: CommissioningPlan;
  outlook: MicrosoftOutlookRuntime;
  reconciliation: EnabledRuntimeReconciliationConfig;
  projectRevision: number;
  workflow?: boolean;
}): Promise<CommissioningRunEvidence> {
  const { request, environment, plan, outlook, reconciliation } = input;
  const projectRevisionNumber = input.projectRevision;
  const token = environment.JARVIS_SERVICE_TOKEN?.trim() ?? "";
  const approvalToken = environment.JARVIS_APPROVAL_TOKEN?.trim() ?? "";
  const marker = `outlook-commission-${randomUUID()}`;
  const createdClient = expectStatus(
    await request({
      baseUrl: plan.apiBaseUrl,
      token,
      method: "POST",
      path: "/api/v1/clients",
      body: { name: `Outlook commissioning ${marker}` },
    }),
    201,
    "Create disposable client",
  );
  if (
    !isRecord(createdClient) ||
    !isRecord(createdClient.data) ||
    typeof createdClient.data.id !== "string"
  ) {
    throw new Error("Disposable client response did not include an id.");
  }
  const clientId = createdClient.data.id;
  const call: WorkflowCall = async (method, path, body, expected = 200) =>
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method,
        path,
        ...(body === undefined ? {} : { body }),
      }),
      expected,
      `${method} ${path}`,
    );
  const workflowStart = input.workflow
    ? await startBeezTreezWorkflow({ call, clientId, marker })
    : null;
  const lineItems = [{ description: "Disposable commissioning line", quantity: 1, unitPrice: 1 }];
  let snapshot = readSnapshot(
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method: "POST",
        path: "/api/v1/quotes",
        body: {
          clientId,
          ...(workflowStart ? { projectId: workflowStart.projectId } : {}),
          number: `Q-${marker}`.slice(0, 100),
          lineItems,
          termsIncluded: true,
        },
      }),
      201,
      "Create quote draft",
    ),
  );
  const quoteProjectId = snapshot.projectId ?? null;
  snapshot = readSnapshot(
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method: "PATCH",
        path: `/api/v1/quotes/${encodeURIComponent(snapshot.quoteId)}/revisions/${snapshot.revision}`,
        body: { ...envelope(snapshot), patch: { notes: "Commissioning draft edit" } },
      }),
      200,
      "Edit quote draft",
    ),
  );
  snapshot = readSnapshot(
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method: "POST",
        path: `/api/v1/quotes/${encodeURIComponent(snapshot.quoteId)}/revisions/${snapshot.revision}/review`,
        body: envelope(snapshot),
      }),
      200,
      "Review quote",
    ),
  );
  snapshot = readSnapshot(
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method: "POST",
        path: `/api/v1/quotes/${encodeURIComponent(snapshot.quoteId)}/revisions/${snapshot.revision}/finalize`,
        body: {
          ...envelope(snapshot),
          issuer: { name: "Jarvis commissioning" },
          client: { name: "Non-customer commissioning mailbox", email: plan.recipient },
        },
      }),
      200,
      "Finalise quote",
    ),
  );
  if (snapshot.status !== "finalized" || !snapshot.fingerprint) {
    throw new Error("Finalise did not stamp a fingerprint.");
  }
  const sendActionId = `${marker}-send`;
  await stageSend({
    request,
    plan,
    token,
    approvalToken,
    projectRevision: projectRevisionNumber,
    actionId: sendActionId,
    quoteId: snapshot.quoteId,
    fingerprint: snapshot.fingerprint,
  });
  const sent = await executeSend({ request, plan, token, actionId: sendActionId });
  if (!sent.providerRequestId || !sent.reconciliationId) {
    throw new Error(
      `quotes:send did not capture a Graph message identity (receipt status ${sent.status}).`,
    );
  }
  const worker = createOutlookReconciliationWorker(outlook, reconciliation);
  const workerRuns: CommissioningWorkerRun[] = [];
  await drainWorker(worker, `${marker}-first`, workerRuns);
  await stageSend({
    request,
    plan,
    token,
    approvalToken,
    projectRevision: projectRevisionNumber,
    actionId: `${marker}-repeat`,
    quoteId: snapshot.quoteId,
    fingerprint: snapshot.fingerprint,
  });
  const repeated = await executeSend({ request, plan, token, actionId: `${marker}-repeat` });
  await drainWorker(worker, `${marker}-again`, workerRuns);
  const deliveries = expectStatus(
    await request({
      baseUrl: plan.apiBaseUrl,
      token,
      method: "GET",
      path: `/api/v1/quotes/${encodeURIComponent(snapshot.quoteId)}/deliveries`,
    }),
    200,
    "List deliveries",
  );
  const deliveryCount =
    isRecord(deliveries) && Array.isArray(deliveries.data) ? deliveries.data.length : -1;
  const records = await readReconciliations({
    request,
    plan,
    token,
    reconciliationId: sent.reconciliationId,
  });
  const proof = assertOutlookCommissioningProof({
    providerRequestId: sent.providerRequestId,
    repeatSendStatus: repeated.status,
    deliveryCount,
    records,
  });
  const reconciliationDetail = expectStatus(
    await request({
      baseUrl: plan.apiBaseUrl,
      token,
      method: "GET",
      path: `/api/v1/reconciliations/${encodeURIComponent(sent.reconciliationId)}`,
    }),
    200,
    "Get reconciliation",
  );
  const trace = commissioningTrace({
    repeatReceipt: repeated.body,
    deliveries,
    reconciliationDetail,
    workers: workerRuns,
  });
  let workflow: BeezTreezWorkflowEvidence | undefined;
  if (workflowStart) {
    const finished = await finishBeezTreezWorkflow({
      call,
      clientId,
      marker,
      enquiryId: workflowStart.enquiryId,
      projectId: workflowStart.projectId,
      quoteId: snapshot.quoteId,
      lineItems,
    });
    const sent = trace.deliveries.find(
      (entry) => entry.providerRequestId === trace.reconciliation?.providerRequestId,
    );
    const assessed = assessBeezTreezWorkflow({
      propertyId: workflowStart.propertyId,
      projectId: workflowStart.projectId,
      quoteId: snapshot.quoteId,
      enquiry: finished.enquiry,
      quoteProjectId,
      reconciledOutcome:
        typeof sent?.reconciledOutcome === "string" ? sent.reconciledOutcome : null,
      invoice: finished.invoice,
      briefBefore: workflowStart.briefBefore,
      briefAfter: finished.briefAfter,
      hud: finished.hud,
    });
    workflow = {
      clientId,
      propertyId: workflowStart.propertyId,
      enquiryId: workflowStart.enquiryId,
      projectId: workflowStart.projectId,
      quoteId: snapshot.quoteId,
      invoiceId: finished.invoiceId,
      briefBefore: workflowStart.briefBefore,
      briefAfter: finished.briefAfter,
      hud: finished.hud,
      ...assessed,
    };
  }
  return {
    ...proof,
    quoteId: snapshot.quoteId,
    revision: snapshot.revision,
    recipient: plan.recipient,
    trace,
    ...(workflow ? { workflow } : {}),
  };
}

export async function executeOutlookQuoteCommissioning(
  environment: NodeJS.ProcessEnv,
  overrides: {
    request?: CommissioningRequest;
    loadProjectRevision?: (plan: CommissioningPlan, serviceToken: string) => Promise<number | null>;
    createOutlookRuntime?: typeof createMicrosoftOutlookRuntimeFromEnv;
    /** Run the end-to-end Beez Treez workflow around the send (one send, same guards). */
    workflow?: boolean;
  } = {},
): Promise<CommissioningRunEvidence> {
  const normalised = normaliseCommissioningEnvironment(environment);
  const request = overrides.request ?? requestJson;
  const token = normalised.JARVIS_SERVICE_TOKEN?.trim() ?? "";
  const plan = await beginOutlookQuoteCommissioning({
    environment: normalised,
    loadClientContactValues: () =>
      loadContacts(request, normalised.JARVIS_API_BASE_URL ?? "", token),
  });
  const senderConnection = commissioningSenderConnection(normalised);
  const planned = senderConnection === undefined ? plan : { ...plan, senderConnection };
  const outlook = (overrides.createOutlookRuntime ?? createMicrosoftOutlookRuntimeFromEnv)(
    normalised,
  );
  if (!outlook) {
    throw new Error(
      "Outlook quote commissioning refused: the Microsoft Outlook runtime is not configured.",
    );
  }
  const reconciliation = resolveRuntimeReconciliationConfig(normalised);
  if (!reconciliation.enabled) {
    throw new Error("Outlook quote commissioning refused: reconciliation is not enabled.");
  }
  const revision = requireProject(
    await (overrides.loadProjectRevision ?? projectRevision)(planned, token),
  );
  return runCommissioning({
    request,
    environment: normalised,
    plan: planned,
    outlook,
    reconciliation,
    projectRevision: revision,
    ...(overrides.workflow ? { workflow: true } : {}),
  });
}

/** Always returns a non-empty, single-line message so a failed run is never silent. */
export function describeCommissioningFailure(error: unknown): string {
  const fallback = "Outlook quote commissioning failed";
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0
      ? message
      : `${fallback}: ${error.name || "Error"} with no message (nothing was sent unless evidence was written).`;
  }
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return `${fallback}: non-Error value thrown (nothing was sent unless evidence was written).`;
}

/** `--workflow` runs the end-to-end Beez Treez workflow proof around the same single send. */
export function commissioningModeFromArgs(args: readonly string[]): { workflow: boolean } {
  const unknown = args.filter((arg) => arg !== "--workflow");
  if (unknown.length > 0) {
    throw new Error(`Unknown commissioning argument: ${unknown[0]}`);
  }
  return { workflow: args.includes("--workflow") };
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const mode = commissioningModeFromArgs(process.argv.slice(2));
  const evidence = await executeOutlookQuoteCommissioning(process.env, mode);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = process.env.JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE?.trim();
  if (evidencePath) {
    if (!path.isAbsolute(evidencePath)) {
      throw new Error("JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE must be an absolute path.");
    }
    await writeFile(evidencePath, json, { mode: 0o600 });
  }
  process.stdout.write(json);
  const failed = workflowFailure(mode, evidence);
  if (failed) {
    console.error(failed);
    process.exitCode = 1;
  }
}

/** In workflow mode the run passes only when the whole chain was proven. */
export function workflowFailure(
  mode: { workflow: boolean },
  evidence: Pick<CommissioningRunEvidence, "workflow">,
): string | null {
  if (!mode.workflow) return null;
  if (!evidence.workflow) return "Workflow proof failed: no workflow evidence was recorded.";
  if (evidence.workflow.proven) return null;
  const broken = Object.entries(evidence.workflow.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return `Workflow proof failed: ${broken.join(", ")}. The send itself is reported separately in the evidence.`;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(describeCommissioningFailure(error));
    process.exitCode = 1;
  });
}
