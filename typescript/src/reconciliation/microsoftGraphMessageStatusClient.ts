import type {
  OutlookMessageStatusClient,
  OutlookMessageStatusResult,
} from "./outlookMailReconciliationAdapter.js";

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
    const token = await this.getAccessToken(input.signal);
    const url = new URL(
      `${this.graphOrigin}/users/${encodeURIComponent(input.mailbox)}/messages/${encodeURIComponent(
        input.immutableMessageId,
      )}`,
    );
    url.searchParams.set("$select", "id,isDraft,sentDateTime,internetMessageId");
    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Prefer: 'IdType="ImmutableId"',
      },
      redirect: "error",
      signal: input.signal,
    });
    if (response.status !== 200) return { status: "rejected" };
    return messageStatus(await response.json());
  }
}
