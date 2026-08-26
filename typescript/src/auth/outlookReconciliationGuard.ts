type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Quote send via Outlook leaves delivery indeterminate until the reconciliation
 * worker observes the Graph message. Enabling Outlook without reconciliation
 * would register quotes:send while no worker can resolve outcomes.
 */
export function assertOutlookReconciliationPairing(environment: Environment = process.env): void {
  if (environment.JARVIS_OUTLOOK_ENABLED !== "true") {
    return;
  }
  if (environment.JARVIS_RECONCILIATION_ENABLED === "true") {
    return;
  }
  throw new Error(
    "JARVIS_OUTLOOK_ENABLED=true requires JARVIS_RECONCILIATION_ENABLED=true so quote send outcomes can be resolved.",
  );
}
