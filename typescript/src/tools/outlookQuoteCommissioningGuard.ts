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
  /** Set only for named Outlook connections. Legacy mode omits it. */
  senderConnection?: string;
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

/**
 * Node's `.env.local` parser drops an unquoted trailing `#` comment.
 * A systemd EnvironmentFile keeps that comment in the value. Strip one
 * so both sources name the same deployment. Quoted values are left whole.
 */
export function stripUnquotedTrailingComment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const hash = trimmed.search(/\s+#/u);
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
}

export function normaliseCommissioningEnvironment<T extends CommissioningEnvironment>(
  environment: T,
): T {
  const deployment = environment.CONVEX_DEPLOYMENT;
  if (deployment === undefined) return environment;
  const stripped = stripUnquotedTrailingComment(deployment);
  if (stripped === deployment) return environment;
  return { ...environment, CONVEX_DEPLOYMENT: stripped };
}

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
  if (url.protocol !== "https:") {
    throw refused("CONVEX_URL for a Convex cloud host must be https.");
  }
  if (url.port !== "" || authorityHasExplicitPort(raw)) {
    throw refused("CONVEX_URL must be loopback or exactly the dev deployment host.");
  }
  if (url.hostname !== `${slug}.convex.cloud`) {
    throw refused("CONVEX_URL must be loopback or exactly the dev deployment host.");
  }
}

const ATEXT = "[a-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOT_ATOM = `${ATEXT}+(?:\\.${ATEXT}+)*`;
const DOMAIN = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+";
const PLAIN_MAILBOX = new RegExp(`^${DOT_ATOM}@${DOMAIN}$`, "u");
const DOT_ATOM_ONLY = new RegExp(`^${DOT_ATOM}$`, "u");

function stripMailto(value: string): string {
  return value.toLowerCase().startsWith("mailto:") ? value.slice("mailto:".length).trim() : value;
}

/** Lowercase and trim only. Quotes, comments, encoded words, display names, and trailing dots are rejected. */
function plainMailbox(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text.includes("=?") || text.includes("?=")) return null;
  if (text.length === 0 || text.length > 320 || !PLAIN_MAILBOX.test(text)) return null;
  return text;
}

function removeComments(value: string): string | null {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return depth === 0 ? out : null;
}

function stripTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ".") end -= 1;
  return value.slice(0, end);
}

function unquoteDotAtomLocal(value: string): string | null {
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local.startsWith('"')) return `${local}@${domain}`;
  if (!local.endsWith('"') || local.length < 2) return null;
  const inner = local.slice(1, -1);
  if (!DOT_ATOM_ONLY.test(inner)) return null;
  return `${inner}@${domain}`;
}

/** Format, bidi, and zero-width marks. Stripped before a contact is compared. */
const CONTACT_MARKS = /[\p{Cf}\p{Bidi_Control}]/gu;

/**
 * Letters, digits, space, and the punctuation a stored Jarvis contact may use.
 * `=` and `?` are excluded: client contacts are plain values, not MIME headers.
 */
const CONTACT_ALLOWED = new RegExp(String.raw`^[\p{L}\p{N} ._+\-@()<> ,;:'"/]*$`, "u");

/**
 * NFKC, then format/bidi/zero-width stripping, repeated until the string is unchanged.
 * A value that does not reach a fixed point is unparseable.
 */
function foldContact(value: string): string | null {
  let current = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = current.normalize("NFKC").replace(CONTACT_MARKS, "");
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** True when the folded contact is plain text. Checked before comments are removed. */
function contactIsPlain(value: string): boolean {
  return !value.includes("=") && !value.includes("?") && CONTACT_ALLOWED.test(value);
}

/** Letters and numbers only, lowercased. Used to spot a recipient local part. */
function contactSkeleton(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function unquoteQuotedAtoms(value: string): string {
  return value.replace(/"([^"]*)"/gu, (full, inner: string) => {
    return DOT_ATOM_ONLY.test(inner) ? inner : full;
  });
}

/** True when already-folded residue still holds an address, or the fold is invalid. */
function residueContainsMailbox(value: string): boolean {
  if (value.trim().length === 0) return false;
  const uncommented = removeComments(value.toLowerCase());
  if (uncommented === null) return true;
  return unquoteQuotedAtoms(uncommented).includes("@");
}

/**
 * One angle-addr, or the original text when it has no brackets.
 * A second mailbox outside the brackets is refused.
 */
function singleAngleAddr(text: string): string | null {
  if (!text.includes("<") && !text.includes(">")) return text;
  const opens = [...text.matchAll(/</gu)];
  const closes = [...text.matchAll(/>/gu)];
  const open = opens[0];
  const close = closes[0];
  if (opens.length !== 1 || closes.length !== 1 || !open || !close) return null;
  if (open.index === undefined || close.index === undefined || close.index < open.index)
    return null;
  const inside = text.slice(open.index + 1, close.index);
  const before = text.slice(0, open.index);
  const after = text.slice(close.index + 1);
  if (before.includes("@") || after.includes("@")) return null;
  if (residueContainsMailbox(before) || residueContainsMailbox(after)) return null;
  return inside;
}

/**
 * One mailbox in an already-folded plain contact.
 * Plus-tags stay. More than one mailbox is null.
 */
function exactMailbox(value: string): string | null {
  const stripped = stripMailto(value.trim());
  const angled = singleAngleAddr(stripped);
  if (angled === null) return null;
  let text = stripMailto(angled.trim()).toLowerCase();
  const uncommented = removeComments(text);
  if (uncommented === null) return null;
  if ((uncommented.match(/@/gu) ?? []).length !== 1) return null;
  const unquoted = unquoteDotAtomLocal(stripTrailingDots(uncommented.trim()));
  if (unquoted === null) return null;
  text = unquoted.trim();
  if ((text.match(/@/gu) ?? []).length !== 1) return null;
  if (text.length === 0 || text.length > 320 || !PLAIN_MAILBOX.test(text)) return null;
  return text;
}

function recipientAllowlist(environment: CommissioningEnvironment): ReadonlySet<string> {
  const raw = required(environment, "JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST");
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw refused(
      "JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST must list at least one plain email address.",
    );
  }
  const mailboxes = new Set<string>();
  for (const entry of entries) {
    const mailbox = plainMailbox(entry);
    if (!mailbox) {
      throw refused(
        "JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT_ALLOWLIST must list plain email addresses.",
      );
    }
    mailboxes.add(mailbox);
  }
  return mailboxes;
}

/** Customer-contact key: exact mailbox with one `+tag` removed from the local part. */
function contactKey(value: string): string | null {
  const folded = foldContact(value);
  if (folded === null || !contactIsPlain(folded)) return null;
  const mailbox = exactMailbox(folded);
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
 * a non-loopback API, a recipient that is not a plain email address, and a
 * recipient that is not on the operator allowlist.
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

  const deployment = stripUnquotedTrailingComment(required(environment, "CONVEX_DEPLOYMENT"));
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

  const recipient = plainMailbox(required(environment, "JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT"));
  if (!recipient) {
    throw refused("JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT must be an email address.");
  }
  const allowlist = recipientAllowlist(environment);
  if (!allowlist.has(recipient)) {
    throw refused("JARVIS_OUTLOOK_COMMISSIONING_RECIPIENT is not on the commissioning allowlist.");
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

/** Top-level comment bodies. Unbalanced parentheses are not a contact we can compare. */
function commentBodies(value: string): string[] | null {
  const bodies: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) return null;
      depth -= 1;
      if (depth === 0) bodies.push(value.slice(start, index));
    }
  }
  return depth === 0 ? bodies : null;
}

/**
 * Mailboxes that exist only inside comments. A comment with no address is
 * ignored. An address-like comment that is not one mailbox is refused.
 */
function mailboxesHiddenInComments(value: string): string[] | "refuse" | "none" {
  const bodies = commentBodies(value);
  if (bodies === null) return "refuse";
  if (bodies.length === 0) return "none";
  const found: string[] = [];
  for (const body of bodies) {
    const nested = mailboxesHiddenInComments(body);
    if (nested === "refuse") return "refuse";
    if (nested !== "none") found.push(...nested);
    const uncommented = removeComments(body);
    if (uncommented === null) return "refuse";
    if (uncommented.includes("@") || uncommented.includes("<") || uncommented.includes(">")) {
      const mailbox = exactMailbox(uncommented);
      if (!mailbox) return "refuse";
      found.push(mailbox);
    }
  }
  return found.length === 0 ? "none" : found;
}

/** Local part of the recipient, folded the same way, then reduced to letters and numbers. */
function recipientLocalSkeleton(recipient: string): string {
  const at = recipient.lastIndexOf("@");
  if (at <= 0) return "";
  const folded = foldContact(recipient.slice(0, at));
  return contactSkeleton(folded ?? "");
}

/**
 * The recipient local part inside a contact that is not exactly that mailbox.
 * An extracted mailbox equal to the recipient is a customer collision, not this refusal.
 */
function localPartThreat(folded: string, mailbox: string | null, recipient: string): boolean {
  if (mailbox === recipient) return false;
  const local = recipientLocalSkeleton(recipient);
  return local.length > 0 && contactSkeleton(folded).includes(local);
}

/**
 * Phone numbers and names that contain no address are ignored.
 * The folded contact is checked before comments are removed. That same string
 * is the only input to mailbox extraction and the skip decision.
 * Zero mailboxes skip. Exactly one mailbox is compared. Anything else refuses.
 */
function contactForComparison(
  value: string,
  recipient: string,
): "skip" | "refuse" | { mailbox: string } {
  const folded = foldContact(value);
  if (folded === null || !contactIsPlain(folded)) return "refuse";
  const hidden = mailboxesHiddenInComments(folded);
  if (hidden === "refuse") return "refuse";
  const visible = exactMailbox(folded);
  if (visible) {
    if (hidden !== "none") return "refuse";
    if (localPartThreat(folded, visible, recipient)) return "refuse";
    return { mailbox: visible };
  }
  const uncommented = removeComments(folded);
  if (uncommented === null) return "refuse";
  const residue = unquoteQuotedAtoms(uncommented);
  if (residue.includes("@") || residue.includes("<") || residue.includes(">")) return "refuse";
  if (hidden === "none") return localPartThreat(folded, null, recipient) ? "refuse" : "skip";
  if (hidden.length !== 1) return "refuse";
  const only = hidden[0];
  if (only === undefined) return "refuse";
  if (localPartThreat(folded, only, recipient)) return "refuse";
  return { mailbox: only };
}

/**
 * Loads client contacts only after the environment guard has passed, and
 * refuses when an email-shaped contact is the commissioning mailbox.
 */
export async function beginOutlookQuoteCommissioning(input: {
  environment: CommissioningEnvironment;
  loadClientContactValues: () => Promise<readonly string[]>;
}): Promise<CommissioningPlan> {
  const plan = assessOutlookQuoteCommissioningGuard(input.environment);
  const contacts = await input.loadClientContactValues();
  const emailContacts: string[] = [];
  for (const value of contacts) {
    const disposition = contactForComparison(value, plan.recipient);
    if (disposition === "skip") continue;
    if (disposition === "refuse") {
      throw refused("a client contact could not be parsed into one mailbox.");
    }
    emailContacts.push(disposition.mailbox);
  }
  const contained = emailContacts.some((value) => value.toLowerCase().includes(plan.recipient));
  if (recipientCollidesWithContacts(plan.recipient, emailContacts) || contained) {
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
