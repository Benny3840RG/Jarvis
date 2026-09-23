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
  /** Clock used to turn an HTTP-date Retry-After into a wait. */
  now?: () => number;
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

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

type ParsedRetryAfter =
  { kind: "none" } | { kind: "delay"; retryAfterMs: number } | { kind: "unschedulable" };

/**
 * RFC 9110 Retry-After is either delta-seconds or an IMF-fixdate.
 * A representable wait is returned whole. Dropping a longer wait would let a
 * later scheduler retry early. A delay that cannot be represented as a safe
 * millisecond count is unschedulable rather than shortened. Junk and obsolete
 * date forms are not treated as a provider minimum.
 */
function parseRetryAfter(value: string | null, nowMs: number): ParsedRetryAfter {
  if (value === null) return { kind: "none" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "none" };

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const retryAfterMs = seconds * 1_000;
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(retryAfterMs)) {
      return { kind: "unschedulable" };
    }
    return { kind: "delay", retryAfterMs };
  }

  if (!IMF_FIXDATE.test(trimmed)) return { kind: "none" };
  if (!Number.isSafeInteger(nowMs)) return { kind: "unschedulable" };
  const instant = Date.parse(trimmed);
  if (!Number.isSafeInteger(instant)) return { kind: "none" };
  const delay = instant - nowMs;
  if (!Number.isSafeInteger(delay)) return { kind: "unschedulable" };
  return { kind: "delay", retryAfterMs: Math.max(0, delay) };
}

export class MicrosoftGraphMessageStatusClient implements OutlookMessageStatusClient {
  private readonly getAccessToken: AccessTokenSupplier;
  private readonly fetch: typeof globalThis.fetch;
  private readonly graphOrigin: "https://graph.microsoft.com/v1.0";
  private readonly now: () => number;

  constructor(options: MicrosoftGraphMessageStatusClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.graphOrigin = options.graphOrigin ?? "https://graph.microsoft.com/v1.0";
    this.now = options.now ?? Date.now;
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
        const parsed = parseRetryAfter(response.headers.get("retry-after"), this.now());
        if (parsed.kind === "unschedulable") {
          return { status: "throttled", retryAfterUnschedulable: true };
        }
        if (parsed.kind === "delay") {
          return { status: "throttled", retryAfterMs: parsed.retryAfterMs };
        }
        return { status: "throttled" };
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
