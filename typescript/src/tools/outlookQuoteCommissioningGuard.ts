export const OUTLOOK_COMMISSIONING_CONFIRMATION = "non-customer";

const TERMINAL_STATUSES = ["succeeded", "failed", "no-effect"] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type CommissioningEnvironment = Readonly<Record<string, string | undefined>>;

export type CommissioningPlan = {
  recipient: string;
  projectKey: string;
  apiBaseUrl: string;
  convexUrl: string;
  deployment: string;
};

export type ReconciliationObservation = {
  reconciliationId: string;
  providerRequestId?: string;
  state: string;
  terminalStatus?: string;
};

export type CommissioningProofInput = {
  providerRequestId: string;
  repeatSendStatus: string;
  deliveryCount: number;
  records: readonly ReconciliationObservation[];
};

export type OutlookCommissioningEvidence = {
  issues: { "294": "OPEN"; "297": "OPEN" };
  satisfied: false;
  providerRequestId: string;
  reconciliationId: string;
  terminalStatus: TerminalStatus;
  repeatSendPrevented: true;
  deliveryCount: 1;
  matchingReconciliationCount: 1;
};

function refused(reason: string): Error {
  return new Error(`Outlook quote commissioning refused: ${reason}`);
}

function required(environment: CommissioningEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw refused(`${name} is required.`);
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function parseHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refused(`${name} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw refused(`${name} must be an absolute http(s) URL.`);
  }
  return url;
}

const DEPLOYMENT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function developmentSlug(deployment: string): string {
  if (deployment.startsWith("prod:") || !deployment.startsWith("dev:")) {
    throw refused("CONVEX_DEPLOYMENT must identify a development deployment (dev:...).");
  }
  const slug = deployment.slice("dev:".length).trim().toLowerCase();
  if (!DEPLOYMENT_SLUG.test(slug)) {
    throw refused("CONVEX_DEPLOYMENT must identify a development deployment (dev:...).");
  }
  return slug;
}

function authorityHasExplicitPort(value: string): boolean {
  const scheme = value.indexOf("://");
  const rest = scheme === -1 ? value : value.slice(scheme + 3);
  const end = rest.search(/[/?#]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  const hostport = at === -1 ? authority : authority.slice(at + 1);
  if (hostport.startsWith("[")) return hostport.includes("]:");
  return hostport.includes(":");
}

function assertDevelopmentConvexUrl(raw: string, url: URL, slug: string): void {
  if (url.username !== "" || url.password !== "") {
    throw refused("CONVEX_URL must be loopback or exactly the dev deployment host.");
  }
  if (isLoopbackHost(url.hostname)) return;
  if (url.port !== "" || authorityHasExplicitPort(raw)) {
    throw refused("CONVEX_URL must be loopback or exactly the dev deployment host.");
  }
  if (url.hostname !== `${slug}.convex.cloud`) {
    throw refused("CONVEX_URL must be loopback or exactly the dev deployment host.");
  }
}

function stripMailto(value: string): string {
  return value.toLowerCase().startsWith("mailto:") ? value.slice("mailto:".length).trim() : value;
}

/** Addr-spec after display-name, mailto, case, and one trailing-dot fold. Plus-tags stay. */
function exactMailbox(value: string): string | null {
  let text = stripMailto(value.trim());
  const wrapped = text.match(/<([^<>]+)>/u);
  if (wrapped?.[1]) text = stripMailto(wrapped[1].trim());
  text = text.trim().toLowerCase();
  if (text.endsWith(".")) text = text.slice(0, -1);
  if (text.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return null;
  return text;
}

/** Customer-contact key: exact mailbox with one `+tag` removed from the local part. */
function contactKey(value: string): string | null {
  const mailbox = exactMailbox(value);
  if (!mailbox) return null;
  const at = mailbox.lastIndexOf("@");
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  if (!base) return null;
  return `${base}@${domain}`;
}

/**
 * Refuses production, a Convex URL that is not loopback or this dev deployment,
 * a non-loopback API, and a recipient that is not an email address.
 * Returns before any quote, send, or reconciliation call.
 */
export function assessOutlookQuoteCommissioningGuard(
  environment: CommissioningEnvironment,
): CommissioningPlan {
  const jarvisEnvironment = required(environment, "JARVIS_ENVIRONMENT");
  if (jarvisEnvironment === "production") {
    throw refused("JARVIS_ENVIRONMENT=production.");
  }
  if (jarvisEnvironment !== "development") {
    throw refused("JARVIS_ENVIRONMENT must be development.");
  }

  const deployment = required(environment, "CONVEX_DEPLOYMENT");
  const slug = developmentSlug(deployment);

  const convexRaw = required(environment, "CONVEX_URL");
  const convexUrl = parseHttpUrl(convexRaw, "CONVEX_URL");
  assertDevelopmentConvexUrl(convexRaw, convexUrl, slug);

  const apiBaseUrl = parseHttpUrl(
    required(environment, "JARVIS_API_BASE_URL"),
    "JARVIS_API_BASE_URL",
  );
  if (!isLoopbackHost(apiBaseUrl.hostname)) {
    throw refused("JARVIS_API_BASE_URL must be a loopback URL.");
  }

  if (environment.JARVIS_RECONCILIATION_ENABLED !== "true") {
    throw refused("JARVIS_RECONCILIATION_ENABLED=true is required.");
  }
  required(environment, "JARVIS_SERVICE_TOKEN");
  required(environment, "JARVIS_APPROVAL_TOKEN");

  const projectKey = required(environment, "JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY");
  if (/\s/u.test(projectKey) || projectKey.length > 200) {
    throw refused("JARVIS_OUTLOOK_COMMISSIONING_PROJECT_KEY must be a single token.");
  }

  if (environment.JARVIS_OUTLOOK_COMMISSIONING_CONFIRM !== OUTLOOK_COMMISSIONING_CONFIRMATION) {
    throw refused(
      `JARVIS_OUTLOOK_COMMISSIONING_CONFIRM must be ${OUTLOOK_COMMISSIONING_CONFIRMATION}.`,
    );
  }

  const recipient = exactMailbox(required(environment, "JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT"));
  if (!recipient) {
    throw refused("JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT must be an email address.");
  }

  return {
    recipient,
    projectKey,
    apiBaseUrl: apiBaseUrl.toString(),
    convexUrl: convexUrl.toString(),
    deployment,
  };
}

export function recipientCollidesWithContacts(
  recipient: string,
  contactValues: readonly string[],
): boolean {
  const recipientKey = contactKey(recipient);
  if (!recipientKey) return false;
  return contactValues.some((value) => contactKey(value) === recipientKey);
}

/**
 * Loads client contacts only after the environment guard has passed, and
 * refuses when the mailbox is already a client contact.
 */
export async function beginOutlookQuoteCommissioning(input: {
  environment: CommissioningEnvironment;
  loadClientContactValues: () => Promise<readonly string[]>;
}): Promise<CommissioningPlan> {
  const plan = assessOutlookQuoteCommissioningGuard(input.environment);
  const contacts = await input.loadClientContactValues();
  if (recipientCollidesWithContacts(plan.recipient, contacts)) {
    throw refused(
      "the commissioning recipient matches a client contact and is not a non-customer mailbox.",
    );
  }
  return plan;
}

function isTerminalStatus(value: string | undefined): value is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(value ?? "");
}

/**
 * Proves one immutable message identity produced one terminal reconciliation,
 * and that the repeat send did not create another delivery. Issues stay open:
 * this function records the host observation and does not close #294 or #297.
 */
export function assertOutlookCommissioningProof(
  input: CommissioningProofInput,
): OutlookCommissioningEvidence {
  const providerRequestId = input.providerRequestId.trim();
  if (!providerRequestId) {
    throw new Error("Outlook quote commissioning did not capture an immutable Graph message id.");
  }
  if (input.deliveryCount !== 1) {
    throw new Error(
      `Outlook quote commissioning observed ${input.deliveryCount} deliveries; expected exactly one.`,
    );
  }
  if (input.repeatSendStatus !== "failed" && input.repeatSendStatus !== "blocked") {
    throw new Error("Outlook quote commissioning did not observe a prevented repeat send.");
  }
  const matches = input.records.filter((record) => record.providerRequestId === providerRequestId);
  if (matches.length !== 1) {
    throw new Error(
      `Outlook quote commissioning observed ${matches.length} reconciliations for the Graph message; expected exactly one.`,
    );
  }
  const match = matches[0];
  if (!match || match.state !== "resolved" || !isTerminalStatus(match.terminalStatus)) {
    throw new Error(
      "Outlook quote commissioning did not observe exactly one terminal reconciliation result.",
    );
  }
  return {
    issues: { "294": "OPEN", "297": "OPEN" },
    satisfied: false,
    providerRequestId,
    reconciliationId: match.reconciliationId,
    terminalStatus: match.terminalStatus,
    repeatSendPrevented: true,
    deliveryCount: 1,
    matchingReconciliationCount: 1,
  };
}
