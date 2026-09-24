import { createHash, timingSafeEqual } from "node:crypto";

import { isLoopbackHost, resolveHttpListenConfig, type HttpAppConfig } from "../http/config.js";

export const END_OVERLAP_PHRASE = "END OVERLAP";

export const CREDENTIAL_DOC_LINKS = {
  httpApi: "https://github.com/Benny3840/Jarvis/blob/main/typescript/docs/operators/http-api.md",
  mcpPreview:
    "https://github.com/Benny3840/Jarvis/blob/main/typescript/docs/operators/chatgpt-preview.md",
  exposure: "https://github.com/Benny3840/Jarvis/blob/main/typescript/docs/operators/http-api.md",
  rotation: "https://github.com/Benny3840/Jarvis/blob/main/README.md",
  credentials:
    "https://github.com/Benny3840/Jarvis/blob/main/typescript/docs/operators/credentials-settings.md",
  security: "https://github.com/Benny3840/Jarvis/blob/main/SECURITY.md",
} as const;

export type TokenCardId = "service" | "approval" | "delivery";
export type VerifyState = "idle" | "passing" | "failing";
export type EndOverlapContext = "wizard" | "card";
export type RemotePosture = "configured" | "blocked";

export type TokenCard = {
  id: TokenCardId;
  label: string;
  configured: boolean;
  statusLabel: string;
  fingerprint: string | null;
  owner: string | null;
  overlapActive: boolean;
  overlapLabel: string;
  note: string;
  equalsServiceToken: boolean;
  warning: string | null;
};

export type CredentialsStatus = {
  failClosed: boolean;
  banner: string | null;
  approvalsWarning: string | null;
  generation: "local-page" | "unavailable";
  localPage: string | null;
  tokens: [TokenCard, TokenCard, TokenCard];
  bind: {
    httpHost: string;
    httpPort: number;
    httpAuth: "Bearer service token" | "OIDC access token";
    mcpBind: string;
    mcpToken: "Injected server-side only";
    remotePosture: RemotePosture;
    remoteLabel: "Configured" | "Blocked (fail closed)";
    loopbackOnly: boolean;
    liveness: "GET /healthz (public)";
  };
  exposure: {
    mode: "Loopback (supported default)" | "Remote";
    remoteHttp: "off" | "configured";
    remoteHttpLabel: string;
  };
  docs: typeof CREDENTIAL_DOC_LINKS;
  parity: ReadonlyArray<{ ui: string; command: string }>;
};

export type CredentialsPageModel = {
  status: CredentialsStatus;
  /** SHA-256 hex digests of the current and previous service tokens. Not the tokens. */
  serviceDigests: readonly string[];
};

export type CredentialsRuntime = {
  status: CredentialsStatus;
  pageModel: CredentialsPageModel;
  serveLocalPage: boolean;
  serviceDigests: readonly string[];
};

export type CredentialsSource = {
  serviceToken?: string;
  serviceTokenPrevious?: string;
  approvalToken?: string;
  approvalTokenPrevious?: string;
  deliveryToken?: string;
  deliveryTokenPrevious?: string;
  httpHost: string;
  httpPort: number;
  mcpHost: string;
  mcpPort: number;
  remoteGatewayEnabled: boolean;
  tlsTerminated: boolean;
  oidcConfigured: boolean;
  originsConfigured: boolean;
  persistenceProvider: string;
};

const FAIL_CLOSED_BANNER =
  "Service token is missing. Jarvis is fail-closed until JARVIS_SERVICE_TOKEN is set. Dependent status will not authenticate.";

const APPROVALS_UNAVAILABLE = "Approvals unavailable.";

const DELIVERY_COLLISION = "Must differ from the service token.";

export const CREDENTIAL_PARITY: CredentialsStatus["parity"] = [
  {
    ui: "Generate service token",
    command: 'node -e \'console.log(require("node:crypto").randomBytes(32).toString("hex"))\'',
  },
  {
    ui: "Set Convex current and previous",
    command: "printf '%s\\n' \"$OLD_TOKEN\" | npx convex env set JARVIS_SERVICE_TOKEN_PREVIOUS",
  },
  {
    ui: "Remove previous service token",
    command: "npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS",
  },
  {
    ui: "Local env",
    command: "edit .env.local, then chmod 600 .env.local",
  },
  {
    ui: "Verify",
    command: "npm run smoke:convex",
  },
  {
    ui: "HTTP status",
    command: "curl --config - http://127.0.0.1:3000/api/v1/status",
  },
  {
    ui: "Start HTTP",
    command: "npm run start:http",
  },
  {
    ui: "Start preview",
    command: "npm run start:preview",
  },
];

export function secretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function fingerprintSecret(secret: string): string {
  const digest = secretDigest(secret);
  return `${digest.slice(0, 4)}\u2026${digest.slice(-4)}`;
}

export function cleanSecret(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || /\s/.test(value)) return undefined;
  return value;
}

function digestsOf(secrets: Array<string | undefined>): string[] {
  return secrets.filter((secret): secret is string => secret !== undefined).map(secretDigest);
}

export function collidesWithServiceToken(
  candidate: string | undefined,
  serviceTokens: Array<string | undefined>,
): boolean {
  const cleaned = cleanSecret(candidate);
  if (cleaned === undefined) return false;
  const candidateDigest = Buffer.from(secretDigest(cleaned), "hex");
  const comparisons = digestsOf(serviceTokens.map(cleanSecret));
  if (comparisons.length === 0) return false;
  return comparisons.some((digest) => timingSafeEqual(candidateDigest, Buffer.from(digest, "hex")));
}

export function endOverlapCommands(id: TokenCardId): readonly string[] {
  switch (id) {
    case "service":
      return [
        "npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS",
        "Remove JARVIS_SERVICE_TOKEN_PREVIOUS from .env.local if it is set, then chmod 600 .env.local",
      ];
    case "approval":
      return [
        "npx convex env remove JARVIS_APPROVAL_TOKEN_PREVIOUS",
        "Remove JARVIS_APPROVAL_TOKEN_PREVIOUS from .env.local if it is set, then chmod 600 .env.local",
      ];
    case "delivery":
      return [
        "npx convex env remove JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
        "Remove JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS from .env.local if it is set, then chmod 600 .env.local",
      ];
  }
}

export function endOverlapControl(input: {
  confirmation: string;
  verify: VerifyState;
  context: EndOverlapContext;
}): { offered: boolean; primary: boolean; allowed: boolean } {
  const failing = input.verify === "failing";
  const offered = input.context === "card" ? !failing : input.verify === "passing";
  return {
    offered,
    primary: false,
    allowed: offered && input.confirmation === END_OVERLAP_PHRASE,
  };
}

export type EndOverlapDecision = {
  offered: boolean;
  primary: boolean;
  allowed: boolean;
  commands: readonly string[];
};

export function decideEndOverlap(input: {
  tokenId: TokenCardId;
  confirmation: string;
  verify: VerifyState;
  context: EndOverlapContext;
}): EndOverlapDecision {
  const control = endOverlapControl(input);
  return {
    ...control,
    commands: control.allowed ? endOverlapCommands(input.tokenId) : [],
  };
}

const TOKEN_IDS: readonly TokenCardId[] = ["service", "approval", "delivery"];
const VERIFY_STATES: readonly VerifyState[] = ["idle", "passing", "failing"];
const CONTEXTS: readonly EndOverlapContext[] = ["wizard", "card"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEndOverlapRequest(body: unknown):
  | {
      ok: true;
      tokenId: TokenCardId;
      confirmation: string;
      verify: VerifyState;
      context: EndOverlapContext;
    }
  | { ok: false } {
  if (!isRecord(body)) return { ok: false };
  const allowed = new Set(["tokenId", "confirmation", "verify", "context"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { ok: false };
  const { tokenId, confirmation, verify, context } = body;
  if (typeof tokenId !== "string" || !TOKEN_IDS.includes(tokenId as TokenCardId))
    return { ok: false };
  if (typeof confirmation !== "string" || confirmation.length > 32) return { ok: false };
  if (typeof verify !== "string" || !VERIFY_STATES.includes(verify as VerifyState))
    return { ok: false };
  if (typeof context !== "string" || !CONTEXTS.includes(context as EndOverlapContext)) {
    return { ok: false };
  }
  return {
    ok: true,
    tokenId: tokenId as TokenCardId,
    confirmation,
    verify: verify as VerifyState,
    context: context as EndOverlapContext,
  };
}

export function parseDeliveryCheckRequest(
  body: unknown,
): { ok: true; digestSha256: string } | { ok: false } {
  if (!isRecord(body)) return { ok: false };
  if (Object.keys(body).some((key) => key !== "digestSha256")) return { ok: false };
  const digest = body.digestSha256;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false };
  return { ok: true, digestSha256: digest };
}

export function deliveryDigestCollides(
  digestSha256: string,
  serviceDigests: readonly string[],
): boolean {
  if (!/^[0-9a-f]{64}$/.test(digestSha256)) return false;
  const candidate = Buffer.from(digestSha256, "hex");
  return serviceDigests.some(
    (digest) =>
      /^[0-9a-f]{64}$/.test(digest) && timingSafeEqual(candidate, Buffer.from(digest, "hex")),
  );
}

function overlapLabel(active: boolean): string {
  return active ? "On (previous token still accepted)" : "Off (previous token rejected)";
}

function tokenCard(input: {
  id: TokenCardId;
  label: string;
  current: string | undefined;
  previous: string | undefined;
  note: string;
  owner: string | null;
  missingStatus: string;
  collision: boolean;
  warning: string | null;
}): TokenCard {
  const configured = input.current !== undefined;
  return {
    id: input.id,
    label: input.label,
    configured,
    statusLabel: configured ? "Present" : input.missingStatus,
    fingerprint: configured ? fingerprintSecret(input.current as string) : null,
    owner: input.owner,
    overlapActive: configured && input.previous !== undefined,
    overlapLabel: overlapLabel(configured && input.previous !== undefined),
    note: input.note,
    equalsServiceToken: input.collision,
    warning: input.collision ? DELIVERY_COLLISION : input.warning,
  };
}

function remotePosture(source: CredentialsSource): RemotePosture {
  if (
    source.remoteGatewayEnabled &&
    source.tlsTerminated &&
    source.oidcConfigured &&
    source.originsConfigured
  ) {
    return "configured";
  }
  return "blocked";
}

export function captureCredentials(source: CredentialsSource): CredentialsRuntime {
  const service = cleanSecret(source.serviceToken);
  const servicePrevious = cleanSecret(source.serviceTokenPrevious);
  const approval = cleanSecret(source.approvalToken);
  const approvalPrevious = cleanSecret(source.approvalTokenPrevious);
  const delivery = cleanSecret(source.deliveryToken);
  const deliveryPrevious = cleanSecret(source.deliveryTokenPrevious);
  const serviceTokens = [service, servicePrevious];
  const deliveryCollision = collidesWithServiceToken(delivery, serviceTokens);
  const approvalCollision = collidesWithServiceToken(approval, serviceTokens);
  const loopbackOnly = isLoopbackHost(source.httpHost);
  const posture = remotePosture(source);
  const remoteExposed = !loopbackOnly && posture === "configured";
  const convex = source.persistenceProvider === "convex";
  const approvalsWarning = approval === undefined ? APPROVALS_UNAVAILABLE : null;
  const httpPort = source.httpPort;
  const localPage = loopbackOnly
    ? `http://${source.httpHost === "::1" ? "[::1]" : source.httpHost}:${httpPort}/settings/credentials`
    : null;

  const serviceCard = tokenCard({
    id: "service",
    label: "Service token",
    current: service,
    previous: servicePrevious,
    owner: "jarvis-cli",
    missingStatus: "Missing",
    note: "Authenticates trusted Jarvis clients to owner jarvis-cli. This is not a sign-in or a password.",
    collision: false,
    warning: null,
  });
  const approvalCard = tokenCard({
    id: "approval",
    label: "Approval token",
    current: approval,
    previous: approvalPrevious,
    owner: null,
    missingStatus: "Missing",
    note: convex
      ? "Required to approve tool-actions. Possessing the service token must not be enough. Convex must hold the same JARVIS_APPROVAL_TOKEN."
      : "Required to approve tool-actions. Possessing the service token must not be enough.",
    collision: approvalCollision,
    warning: approvalsWarning,
  });
  const deliveryCard = tokenCard({
    id: "delivery",
    label: "Delivery runtime token",
    current: delivery,
    previous: deliveryPrevious,
    owner: null,
    missingStatus: "Not configured (OK if delivery unused)",
    note: "Optional until delivery is enabled. Must differ from the service token. Authorises quote delivery-ledger writes.",
    collision: deliveryCollision,
    warning: null,
  });

  const status: CredentialsStatus = {
    failClosed: service === undefined,
    banner: service === undefined ? FAIL_CLOSED_BANNER : null,
    approvalsWarning,
    generation: loopbackOnly ? "local-page" : "unavailable",
    localPage,
    tokens: [serviceCard, approvalCard, deliveryCard],
    bind: {
      httpHost: source.httpHost,
      httpPort,
      httpAuth: loopbackOnly ? "Bearer service token" : "OIDC access token",
      mcpBind: `${source.mcpHost}:${source.mcpPort}/mcp`,
      mcpToken: "Injected server-side only",
      remotePosture: remoteExposed ? "configured" : "blocked",
      remoteLabel: remoteExposed ? "Configured" : "Blocked (fail closed)",
      loopbackOnly,
      liveness: "GET /healthz (public)",
    },
    exposure: {
      mode: loopbackOnly ? "Loopback (supported default)" : "Remote",
      remoteHttp: remoteExposed ? "configured" : "off",
      remoteHttpLabel: remoteExposed
        ? "Configured"
        : "Off — requires TLS + OIDC + origins + limits",
    },
    docs: CREDENTIAL_DOC_LINKS,
    parity: CREDENTIAL_PARITY,
  };

  const serviceDigests = digestsOf(serviceTokens);
  return {
    status,
    pageModel: { status, serviceDigests },
    serveLocalPage: loopbackOnly,
    serviceDigests,
  };
}

function optionalPort(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  return port;
}

function httpsUrl(value: string | undefined): boolean {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function captureCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CredentialsRuntime {
  const listen = resolveHttpListenConfig(env);
  const mcpHost = env.JARVIS_MCP_HOST?.trim() || "127.0.0.1";
  const mcpPort = optionalPort(env.JARVIS_MCP_PORT) ?? 8787;
  const issuer = env.JARVIS_OIDC_ISSUER;
  const audience = env.JARVIS_OIDC_AUDIENCE?.trim();
  const jwks = env.JARVIS_OIDC_JWKS_URL;
  const subject = env.JARVIS_OIDC_SUBJECT?.trim();
  return captureCredentials({
    serviceToken: env.JARVIS_SERVICE_TOKEN,
    serviceTokenPrevious: env.JARVIS_SERVICE_TOKEN_PREVIOUS,
    approvalToken: env.JARVIS_APPROVAL_TOKEN,
    approvalTokenPrevious: env.JARVIS_APPROVAL_TOKEN_PREVIOUS,
    deliveryToken: env.JARVIS_DELIVERY_RUNTIME_TOKEN,
    deliveryTokenPrevious: env.JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS,
    httpHost: listen.host,
    httpPort: listen.port,
    mcpHost,
    mcpPort,
    remoteGatewayEnabled: env.JARVIS_REMOTE_GATEWAY_ENABLED === "true",
    tlsTerminated: env.JARVIS_TLS_TERMINATED === "true",
    oidcConfigured:
      httpsUrl(issuer) &&
      httpsUrl(jwks) &&
      audience !== undefined &&
      audience.length > 0 &&
      subject !== undefined &&
      subject.length > 0,
    originsConfigured: (env.JARVIS_ALLOWED_ORIGINS?.trim().length ?? 0) > 0,
    persistenceProvider: env.PERSISTENCE_PROVIDER?.trim() || "json",
  });
}

export function credentialsSourceFromHttpConfig(config: HttpAppConfig): CredentialsSource {
  const remote = config.authMode === "oidc" || config.remoteGateway !== undefined;
  return {
    serviceToken: config.currentToken,
    serviceTokenPrevious: config.previousToken,
    approvalToken: config.currentApprovalToken,
    approvalTokenPrevious: config.previousApprovalToken,
    httpHost: remote ? "0.0.0.0" : "127.0.0.1",
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: config.remoteGateway !== undefined,
    tlsTerminated: config.remoteGateway?.requireForwardedHttps === true,
    oidcConfigured: config.oidc !== undefined,
    originsConfigured: (config.remoteGateway?.allowedOrigins.length ?? 0) > 0,
    persistenceProvider: "json",
  };
}
