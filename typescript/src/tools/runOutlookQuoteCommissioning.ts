import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { createMicrosoftOutlookRuntimeFromEnv } from "../auth/microsoftOutlookRuntime.js";
import { api } from "../../convex/_generated/api.js";
import { createOutlookReconciliationWorker } from "../reconciliation/outlookRuntimeReconciliation.js";
import { resolveRuntimeReconciliationConfig } from "../reconciliation/runtimeReconciliationHost.js";
import { ReconciliationWorker } from "../reconciliation/reconciliationWorker.js";
import {
  assertOutlookCommissioningProof,
  beginOutlookQuoteCommissioning,
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

async function loadContacts(baseUrl: string, token: string): Promise<string[]> {
  const body = expectStatus(
    await requestJson({ baseUrl, token, method: "GET", path: "/api/v1/clients" }),
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

async function projectRevision(plan: CommissioningPlan, serviceToken: string): Promise<number> {
  const project = await new ConvexHttpClient(plan.convexUrl).query(api.projects.get, {
    serviceToken,
    projectKey: plan.projectKey,
  });
  if (project === null) {
    throw new Error(
      "Outlook quote commissioning refused: the totality project does not exist. This kit does not create one.",
    );
  }
  return project.revision;
}

async function stageSend(input: {
  plan: CommissioningPlan;
  token: string;
  approvalToken: string;
  projectRevision: number;
  actionId: string;
  quoteId: string;
  fingerprint: string;
}): Promise<void> {
  const staged = expectStatus(
    await requestJson({
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
    await requestJson({
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
  plan: CommissioningPlan;
  token: string;
  actionId: string;
}): Promise<{ status: string; providerRequestId?: string; reconciliationId?: string }> {
  return readReceipt(
    expectStatus(
      await requestJson({
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
  plan: CommissioningPlan;
  token: string;
  reconciliationId: string;
}): Promise<ReconciliationObservation[]> {
  const listed = expectStatus(
    await requestJson({
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
    await requestJson({
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

async function runCommissioning(
  environment: NodeJS.ProcessEnv,
  plan: CommissioningPlan,
): Promise<
  OutlookCommissioningEvidence & { quoteId: string; revision: number; recipient: string }
> {
  const outlook = createMicrosoftOutlookRuntimeFromEnv(environment);
  if (!outlook) {
    throw new Error(
      "Outlook quote commissioning refused: the Microsoft Outlook runtime is not configured.",
    );
  }
  const reconciliation = resolveRuntimeReconciliationConfig(environment);
  if (!reconciliation.enabled) {
    throw new Error("Outlook quote commissioning refused: reconciliation is not enabled.");
  }
  const token = environment.JARVIS_SERVICE_TOKEN?.trim() ?? "";
  const approvalToken = environment.JARVIS_APPROVAL_TOKEN?.trim() ?? "";
  const marker = `outlook-commission-${randomUUID()}`;
  const createdClient = expectStatus(
    await requestJson({
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
      await requestJson({
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
      await requestJson({
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
      await requestJson({
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
      await requestJson({
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
  const revision = await projectRevision(plan, token);
  const sendActionId = `${marker}-send`;
  await stageSend({
    plan,
    token,
    approvalToken,
    projectRevision: revision,
    actionId: sendActionId,
    quoteId: snapshot.quoteId,
    fingerprint: snapshot.fingerprint,
  });
  const sent = await executeSend({ plan, token, actionId: sendActionId });
  if (!sent.providerRequestId || !sent.reconciliationId) {
    throw new Error(
      `quotes:send did not capture a Graph message identity (receipt status ${sent.status}).`,
    );
  }
  const worker = createOutlookReconciliationWorker(outlook, reconciliation);
  await drainWorker(worker, `${marker}-first`);
  await stageSend({
    plan,
    token,
    approvalToken,
    projectRevision: revision,
    actionId: `${marker}-repeat`,
    quoteId: snapshot.quoteId,
    fingerprint: snapshot.fingerprint,
  });
  const repeated = await executeSend({ plan, token, actionId: `${marker}-repeat` });
  await drainWorker(worker, `${marker}-again`);
  const deliveries = expectStatus(
    await requestJson({
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

async function main(): Promise<void> {
  loadLocalEnvironment();
  const environment = process.env;
  const token = environment.JARVIS_SERVICE_TOKEN?.trim() ?? "";
  const plan = await beginOutlookQuoteCommissioning({
    environment,
    loadClientContactValues: () => loadContacts(environment.JARVIS_API_BASE_URL ?? "", token),
  });
  const evidence = await runCommissioning(environment, plan);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = environment.JARVIS_OUTLOOK_COMMISSIONING_EVIDENCE?.trim();
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
