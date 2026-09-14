import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  resolveMicrosoftDelegatedOAuthConfig,
  type EnabledMicrosoftDelegatedOAuthConfig,
} from "./microsoftDelegatedOAuth.js";
import {
  createMicrosoftOutlookRuntimeFromEnv,
  type MicrosoftOutlookRuntime,
  type MicrosoftOutlookRuntimeDependencies,
} from "./microsoftOutlookRuntime.js";
import type { QuoteEmailPreparedReference } from "../quotes/quoteEmailProvider.js";

const PROVIDER = "microsoft-graph-mail-connections-v1";
const guid = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu)
  .transform((s) => s.toLowerCase());
const connectionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    clientId: guid,
    mailbox: z
      .string()
      .email()
      .transform((s) => s.toLowerCase()),
    tenantId: guid.optional(),
    refreshTokenFile: z
      .string()
      .startsWith("/")
      .transform((s) => resolve(s)),
  })
  .strict();

type Environment = Readonly<Record<string, string | undefined>>;
export type OutlookConnection = {
  id: string;
  senderConnection: string;
  config: EnabledMicrosoftDelegatedOAuthConfig;
};

export function resolveOutlookConnections(environment: Environment): OutlookConnection[] {
  if (
    ["CLIENT_ID", "MAILBOX", "REFRESH_TOKEN_FILE", "TENANT_ID"].some(
      (key) => environment[`JARVIS_OUTLOOK_${key}`] !== undefined,
    )
  ) {
    throw new Error("outlook-connection-legacy-config-conflict");
  }
  let entries: z.infer<typeof connectionSchema>[];
  try {
    entries = z
      .array(connectionSchema)
      .min(1)
      .max(2)
      .parse(JSON.parse(environment.JARVIS_OUTLOOK_CONNECTIONS_JSON ?? ""));
  } catch {
    throw new Error("outlook-connections-config-invalid");
  }
  for (const field of ["id", "clientId", "mailbox", "refreshTokenFile"] as const) {
    if (new Set(entries.map((entry) => entry[field])).size !== entries.length) {
      throw new Error("outlook-connections-must-be-independent");
    }
  }
  return entries.map((entry) => {
    const config = resolveMicrosoftDelegatedOAuthConfig({
      JARVIS_OUTLOOK_ENABLED: "true",
      JARVIS_OUTLOOK_CLIENT_ID: entry.clientId,
      JARVIS_OUTLOOK_MAILBOX: entry.mailbox,
      JARVIS_OUTLOOK_REFRESH_TOKEN_FILE: entry.refreshTokenFile,
      ...(entry.tenantId === undefined ? {} : { JARVIS_OUTLOOK_TENANT_ID: entry.tenantId }),
    });
    if (!config.enabled) throw new Error("outlook-connection-disabled");
    // Paths are not identity: moving a secret must not strand a pending delivery.
    const identity = JSON.stringify([
      entry.id,
      config.clientId,
      config.mailbox,
      config.tokenEndpoint,
    ]);
    return {
      id: entry.id,
      config,
      senderConnection: `${entry.id}:${createHash("sha256").update(identity).digest("hex")}`,
    };
  });
}

export function createNamedOutlookRuntime(
  environment: Environment,
  dependencies: MicrosoftOutlookRuntimeDependencies,
): MicrosoftOutlookRuntime {
  if (dependencies.refreshTokenStore || dependencies.messageStatusClient) {
    throw new Error("outlook-connections-shared-dependency-forbidden");
  }
  const connections = resolveOutlookConnections(environment);
  const runtimes = new Map(
    connections.map(({ senderConnection, config }) => {
      const runtime = createMicrosoftOutlookRuntimeFromEnv(
        {
          JARVIS_OUTLOOK_ENABLED: "true",
          JARVIS_OUTLOOK_CLIENT_ID: config.clientId,
          JARVIS_OUTLOOK_MAILBOX: config.mailbox,
          JARVIS_OUTLOOK_REFRESH_TOKEN_FILE: config.refreshTokenFile,
          ...(config.tokenEndpoint.includes("/consumers/")
            ? {}
            : { JARVIS_OUTLOOK_TENANT_ID: config.tokenEndpoint.split("/")[3] }),
        },
        dependencies,
      );
      if (!runtime) throw new Error("outlook-connection-disabled");
      return [senderConnection, runtime] as const;
    }),
  );
  function select(key: string | undefined): MicrosoftOutlookRuntime {
    const runtime = key === undefined ? undefined : runtimes.get(key);
    if (!runtime) throw new Error("outlook-sender-connection-invalid");
    return runtime;
  }
  function unpack(reference: QuoteEmailPreparedReference) {
    try {
      if (
        reference.providerRequestId !== reference.providerCorrelationId ||
        reference.providerRequestId.length > 1024 ||
        !reference.providerRequestId.startsWith("outlook:v1:")
      )
        throw new Error();
      const encoded = reference.providerRequestId.slice("outlook:v1:".length);
      if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        value.some((part) => typeof part !== "string" || !part.trim())
      )
        throw new Error();
      const [key, id] = value as [string, string];
      if (Buffer.from(JSON.stringify([key, id])).toString("base64url") !== encoded)
        throw new Error();
      return {
        runtime: select(key),
        reference: { providerRequestId: id, providerCorrelationId: id },
      };
    } catch {
      throw new Error("outlook-connection-reference-invalid");
    }
  }
  return {
    mailbox: connections.map(({ config }) => config.mailbox).join(","),
    quoteEmailProvider: {
      name: PROVIDER,
      validateSender(key) {
        select(key);
      },
      async prepare(input, signal) {
        const prepared = await select(input.senderConnection).quoteEmailProvider.prepare(
          input,
          signal,
        );
        const id = `outlook:v1:${Buffer.from(JSON.stringify([input.senderConnection, prepared.providerRequestId])).toString("base64url")}`;
        if (id.length > 1024) throw new Error("outlook-connection-reference-too-long");
        return { providerRequestId: id, providerCorrelationId: id };
      },
      async sendPrepared(reference, signal) {
        const unpacked = unpack(reference);
        return unpacked.runtime.quoteEmailProvider.sendPrepared(unpacked.reference, signal);
      },
    },
    reconciliationAdapter: {
      provider: PROVIDER,
      async reconcile(reference, signal) {
        if (reference.provider !== PROVIDER)
          return { status: "unresolved", errorCode: "outlook-connection-reference-invalid" };
        let unpacked;
        try {
          unpacked = unpack(reference);
        } catch {
          return { status: "unresolved", errorCode: "outlook-connection-reference-invalid" };
        }
        return unpacked.runtime.reconciliationAdapter.reconcile(
          { ...unpacked.reference, provider: unpacked.runtime.reconciliationAdapter.provider },
          signal,
        );
      },
    },
  };
}
