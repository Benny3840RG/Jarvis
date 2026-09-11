import type { Doc } from "./_generated/dataModel.js";

/** Persisted evidence stays exact; ordinary callers cannot recover worker capabilities. */
export function publicReconciliation(record: Doc<"externalReconciliations">) {
  const { leaseOwner: _owner, leaseToken: _token, ...safe } = record;
  return safe;
}

export function publicDevelopmentEvent(event: Doc<"developmentEvents">) {
  const { canonicalRequestFingerprint: _request, ...safe } = event;
  return safe;
}

export function publicAuditEvent(event: Doc<"auditEvents">) {
  if (event.eventType !== "development.transition.rejected") return event;
  const { canonicalRequestFingerprint: _request, ...payload } = event.payload;
  return { ...event, payload };
}
