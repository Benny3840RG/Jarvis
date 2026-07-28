import type {
  OutlookMessageStatusClient,
  OutlookMessageStatusResult,
} from "./outlookMailReconciliationAdapter.js";
import { OutlookReconciliationError } from "./outlookMailReconciliationAdapter.js";

export type AccessTokenSupplier = (signal: AbortSignal) => Promise<string>;

export type MicrosoftGraphMessageStatusClientOptions = {
  getAccessToken: AccessTokenSupplier;
  fetch?: typeof globalThis.fetch;
  graphOrigin?: "https://graph.microsoft.com/v1.0";
};

type MessageStatusInput = Parameters<OutlookMessageStatusClient["getMessageStatus"]>[0];

function messageStatus(body: unknown): OutlookMessageStatusResult {
  if (typeof body !== "object" || body === null) return { status: "invalid" };
  const record = body as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.isDraft !== "boolean" ||
    (record.sentDateTime !== undefined && typeof record.sentDateTime !== "string") ||
    (record.internetMessageId !== undefined && typeof record.internetMessageId !== "string")
  ) {
    return { status: "invalid" };
  }
  return {
    status: "found",
    immutableMessageId: record.id,
    isDraft: record.isDraft,
    ...(record.sentDateTime === undefined ? {} : { sentDateTime: record.sentDateTime }),
    ...(record.internetMessageId === undefined
      ? {}
      : { internetMessageId: record.internetMessageId }),
  };
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 300 ? seconds * 1_000 : undefined;
}

export class MicrosoftGraphMessageStatusClient implements OutlookMessageStatusClient {
  private readonly getAccessToken: AccessTokenSupplier;
  private readonly fetch: typeof globalThis.fetch;
  private readonly graphOrigin: "https://graph.microsoft.com/v1.0";

  constructor(options: MicrosoftGraphMessageStatusClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.graphOrigin = options.graphOrigin ?? "https://graph.microsoft.com/v1.0";
  }

  async getMessageStatus(input: MessageStatusInput): Promise<OutlookMessageStatusResult> {
    let token: string;
    try {
      token = await this.getAccessToken(input.signal);
    } catch {
      throw new OutlookReconciliationError("outlook-graph-token-unavailable");
    }
    if (!token.trim()) {
      throw new OutlookReconciliationError("outlook-graph-authorization-failed");
    }

    const url = new URL(
      `${this.graphOrigin}/users/${encodeURIComponent(input.mailbox)}/messages/${encodeURIComponent(
        input.immutableMessageId,
      )}`,
    );
    url.searchParams.set("$select", "id,isDraft,sentDateTime,internetMessageId");
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          Prefer: 'IdType="ImmutableId"',
        },
        redirect: "error",
        signal: input.signal,
      });
    } catch {
      throw new OutlookReconciliationError("outlook-graph-request-failed");
    }

    switch (response.status) {
      case 200:
        try {
          return messageStatus(await response.json());
        } catch {
          return { status: "invalid" };
        }
      case 401:
      case 403:
        throw new OutlookReconciliationError("outlook-graph-authorization-failed");
      case 404:
      case 410:
        return { status: "not-observable" };
      case 429: {
        const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
        return {
          status: "throttled",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      case 500:
      case 503:
      case 504:
        return { status: "unavailable" };
      default:
        return { status: "rejected" };
    }
  }
}
