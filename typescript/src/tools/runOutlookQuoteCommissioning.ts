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
  return {
    quoteId,
    aggregateVersion,
    revision: revisionNumber,
    revisionVersion,
    status,
    ...(typeof fingerprint === "string" ? { fingerprint } : {}),
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

async function projectRevision(
  plan: CommissioningPlan,
  serviceToken: string,
): Promise<number | null> {
  const project = await new ConvexHttpClient(plan.convexUrl).query(api.projects.get, {
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
}): Promise<{ status: string; providerRequestId?: string; reconciliationId?: string }> {
  return readReceipt(
    expectStatus(
      await input.request({
        baseUrl: input.plan.apiBaseUrl,
        token: input.token,
        method: "POST",
        path: `/api/v1/projects/${encodeURIComponent(input.plan.projectKey)}/tool-actions/${encodeURIComponent(input.actionId)}/execute`,
        body: { idempotencyKey: input.actionId },
      }),
      200,
      "Execute quotes:send",
    ),
  );
}

async function drainWorker(worker: ReconciliationWorker, marker: string): Promise<void> {
  const signal = AbortSignal.timeout(20_000);
  for (let index = 0; index < 3; index += 1) {
    await worker.runOnce({
      workerId: `${marker}-seq-${index}`,
      leaseMs: 10_000,
      signal,
    });
  }
  await Promise.all([
    worker.runOnce({ workerId: `${marker}-par-a`, leaseMs: 10_000, signal }),
    worker.runOnce({ workerId: `${marker}-par-b`, leaseMs: 10_000, signal }),
  ]);
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
}): Promise<
  OutlookCommissioningEvidence & { quoteId: string; revision: number; recipient: string }
> {
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
  let snapshot = readSnapshot(
    expectStatus(
      await request({
        baseUrl: plan.apiBaseUrl,
        token,
        method: "POST",
        path: "/api/v1/quotes",
        body: {
          clientId,
          number: `Q-${marker}`.slice(0, 100),
          lineItems: [{ description: "Disposable commissioning line", quantity: 1, unitPrice: 1 }],
          termsIncluded: true,
        },
      }),
      201,
      "Create quote draft",
    ),
  );
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
  await drainWorker(worker, `${marker}-first`);
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
  await drainWorker(worker, `${marker}-again`);
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
  return {
    ...proof,
    quoteId: snapshot.quoteId,
    revision: snapshot.revision,
    recipient: plan.recipient,
  };
}

export async function executeOutlookQuoteCommissioning(
  environment: NodeJS.ProcessEnv,
  overrides: {
    request?: CommissioningRequest;
    loadProjectRevision?: (plan: CommissioningPlan, serviceToken: string) => Promise<number | null>;
    createOutlookRuntime?: typeof createMicrosoftOutlookRuntimeFromEnv;
  } = {},
): Promise<
  OutlookCommissioningEvidence & { quoteId: string; revision: number; recipient: string }
> {
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
  });
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const evidence = await executeOutlookQuoteCommissioning(process.env);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = process.env.JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE?.trim();
  if (evidencePath) {
    if (!path.isAbsolute(evidencePath)) {
      throw new Error("JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE must be an absolute path.");
    }
    await writeFile(evidencePath, json, { mode: 0o600 });
  }
  process.stdout.write(json);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Outlook quote commissioning failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
