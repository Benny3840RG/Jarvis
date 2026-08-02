import {
  FileRefreshTokenStore,
  MicrosoftDelegatedAccessTokenSupplier,
  resolveMicrosoftDelegatedOAuthConfig,
  type RefreshTokenStore,
} from "./microsoftDelegatedOAuth.js";
import { MicrosoftGraphQuoteEmailProvider } from "../quotes/microsoftGraphQuoteEmailProvider.js";
import type { QuoteEmailProvider } from "../quotes/quoteEmailProvider.js";
import { MicrosoftGraphMessageStatusClient } from "../reconciliation/microsoftGraphMessageStatusClient.js";
import {
  OutlookMailReconciliationAdapter,
  type OutlookMessageStatusClient,
} from "../reconciliation/outlookMailReconciliationAdapter.js";
import type { ProviderReconciliationAdapter } from "../reconciliation/externalReconciliation.js";

type Environment = Readonly<Record<string, string | undefined>>;

export type MicrosoftOutlookRuntime = {
  mailbox: string;
  quoteEmailProvider: QuoteEmailProvider;
  reconciliationAdapter: ProviderReconciliationAdapter;
};

export type MicrosoftOutlookRuntimeDependencies = {
  refreshTokenStore?: RefreshTokenStore;
  fetch?: typeof globalThis.fetch;
  messageStatusClient?: OutlookMessageStatusClient;
};

export function createMicrosoftOutlookRuntimeFromEnv(
  environment: Environment = process.env,
  dependencies: MicrosoftOutlookRuntimeDependencies = {},
): MicrosoftOutlookRuntime | null {
  const config = resolveMicrosoftDelegatedOAuthConfig(environment);
  if (!config.enabled) return null;

  const refreshTokenStore =
    dependencies.refreshTokenStore ?? new FileRefreshTokenStore(config.refreshTokenFile);
  const accessTokenSupplier = new MicrosoftDelegatedAccessTokenSupplier({
    clientId: config.clientId,
    scopes: config.scopes,
    tokenEndpoint: config.tokenEndpoint,
    refreshTokenStore,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const getAccessToken = (signal: AbortSignal) => accessTokenSupplier.getAccessToken(signal);
  const quoteEmailProvider = new MicrosoftGraphQuoteEmailProvider({
    mailbox: config.mailbox,
    getAccessToken,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const messageStatusClient =
    dependencies.messageStatusClient ??
    new MicrosoftGraphMessageStatusClient({
      getAccessToken,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });

  return {
    mailbox: config.mailbox,
    quoteEmailProvider,
    reconciliationAdapter: new OutlookMailReconciliationAdapter({
      mailbox: config.mailbox,
      client: messageStatusClient,
    }),
  };
}
