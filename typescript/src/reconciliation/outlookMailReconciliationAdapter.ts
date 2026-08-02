import { createHash } from "node:crypto";

import type {
  ProviderAttemptReference,
  ProviderReconciliationAdapter,
  ProviderReconciliationResult,
} from "./externalReconciliation.js";

export const OUTLOOK_MAIL_RECONCILIATION_PROVIDER = "microsoft-graph-mail-v1";

export type OutlookMessageStatusResult =
  | {
      status: "found";
      immutableMessageId: string;
      isDraft: boolean;
      sentDateTime?: string;
      internetMessageId?: string;
    }
  | { status: "not-observable" }
  | { status: "throttled"; retryAfterMs?: number }
  | { status: "unavailable" }
  | { status: "rejected" }
  | { status: "invalid" };

export interface OutlookMessageStatusClient {
  getMessageStatus(input: {
    mailbox: string;
    immutableMessageId: string;
    signal: AbortSignal;
  }): Promise<OutlookMessageStatusResult>;
}

export type OutlookMailReconciliationAdapterOptions = {
  mailbox: string;
  client: OutlookMessageStatusClient;
};

export class OutlookReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OutlookReconciliationError";
  }
}

function unresolved(errorCode: string, retryAfterMs?: number): ProviderReconciliationResult {
  return {
    status: "unresolved",
    errorCode,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function statusDigest(
  reference: ProviderAttemptReference,
  status: Extract<OutlookMessageStatusResult, { status: "found" }>,
): string {
  const canonical = [
    reference.provider,
    status.immutableMessageId,
    status.sentDateTime ?? "",
    status.internetMessageId ?? "",
  ]
    .map((value) => `${value.length}:${value}`)
    .join("|");
  return `outlook-mail-status:v1:sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validReferencePart(value: string): boolean {
  if (value.trim().length === 0 || value.length > 1_024) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export class OutlookMailReconciliationAdapter implements ProviderReconciliationAdapter {
  readonly provider = OUTLOOK_MAIL_RECONCILIATION_PROVIDER;
  private readonly mailbox: string;
  private readonly client: OutlookMessageStatusClient;

  constructor(options: OutlookMailReconciliationAdapterOptions) {
    if (!validReferencePart(options.mailbox)) {
      throw new OutlookReconciliationError("outlook-mailbox-invalid");
    }
    this.mailbox = options.mailbox;
    this.client = options.client;
  }

  async reconcile(
    reference: ProviderAttemptReference,
    signal: AbortSignal,
  ): Promise<ProviderReconciliationResult> {
    if (
      reference.provider !== OUTLOOK_MAIL_RECONCILIATION_PROVIDER ||
      !validReferencePart(reference.providerRequestId) ||
      !validReferencePart(reference.providerCorrelationId)
    ) {
      return unresolved("outlook-provider-reference-invalid");
    }

    let status: OutlookMessageStatusResult;
    try {
      status = await this.client.getMessageStatus({
        mailbox: this.mailbox,
        immutableMessageId: reference.providerRequestId,
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof OutlookReconciliationError) throw error;
      throw new OutlookReconciliationError("outlook-message-status-unavailable");
    }

    switch (status.status) {
      case "found":
        if (status.isDraft) return unresolved("outlook-message-still-draft");
        if (
          status.immutableMessageId !== reference.providerRequestId ||
          status.sentDateTime === undefined ||
          Number.isNaN(Date.parse(status.sentDateTime))
        ) {
          return unresolved("outlook-message-status-invalid");
        }
        return {
          status: "succeeded",
          outputDigest: statusDigest(reference, status),
        };
      case "not-observable":
        return unresolved("outlook-message-not-observable");
      case "throttled":
        return unresolved("outlook-graph-throttled", status.retryAfterMs);
      case "unavailable":
        return unresolved("outlook-graph-unavailable");
      case "rejected":
        return unresolved("outlook-graph-request-rejected");
      case "invalid":
        return unresolved("outlook-message-status-invalid");
    }
  }
}
