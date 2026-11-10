// Public surface of the Stage 3 `security:tcp-check` core (Phases 1–4). These
// modules perform no network effect and import no `node:net`: Phase 1 is the
// pure policy core, Phase 2 the pure admission state machine, Phase 3 the
// supervised egress mediator (enforcer) + single-use ledger behind injected
// ports, and Phase 4 the governed wiring (the T3 tool definition and the egress
// provider). The concrete socket connector and kernel/proxy egress gate are
// commissioning prerequisites supplied later; the provider defaults to a
// fail-closed not-commissioned connector and is not registered into the live
// tool-execution service, so the capability stays `planned` (see issue #779).
// The full adversarial acceptance suite lands in Phase 5. Nothing here opens a
// socket.

export { parseCanonicalAddress, type CanonicalAddress } from "./address.js";
export {
  SPECIAL_USE_TABLE,
  SPECIAL_USE_TABLE_SNAPSHOT_DATE,
  type SpecialUseEntry,
  isSpecialUse,
  serializeSpecialUseTable,
  computeSpecialUseTableDigest,
  verifySpecialUseTable,
} from "./specialUseTable.js";
export { TRUSTED_SPECIAL_USE_TABLE_DIGEST } from "./specialUseTableAnchor.js";
export {
  MIN_PORT,
  MAX_PORT,
  type Allowlist,
  type AllowlistEntry,
  type AllowlistParseResult,
  parseAllowlist,
  isAllowlisted,
} from "./allowlist.js";
export { serializeAllowlist, computeAllowlistDigest } from "./allowlistDigest.js";
export {
  type FreshnessInput,
  type FreshnessReason,
  type FreshnessResult,
  evaluateFreshness,
} from "./freshness.js";
export {
  type AdmissionPhase,
  type AdmissionState,
  type AdmissionStatus,
  type ActiveAttempt,
  type StartedRecord,
  type RateConfig,
  type Transition,
  type ReserveInput,
  type ReserveOutcome,
  type ReserveReason,
  type StartInput,
  type StartOutcome,
  type StartReason,
  type CompleteInput,
  type CompleteOutcome,
  type CompleteReason,
  type RecoverOutcome,
  type ResolveInput,
  type ResolveOutcome,
  type ResolveReason,
  type ResolveSignal,
  RATE_WINDOW_MS,
  DEFAULT_MAX_STARTS_PER_WINDOW,
  DEFAULT_RATE_CONFIG,
  emptyAdmissionState,
  startsInWindow,
  isSlotFree,
  admissionStatus,
  reserve,
  start,
  complete,
  recover,
  resolve,
  releaseReservation,
  markUncertain,
  type ScopedCleanupOutcome,
  type ScopedCleanupReason,
} from "./admission.js";
export { type PolicyView } from "./policy.js";
export { type GateRejection, type GateResult, type GateInput, evaluatePolicyGate } from "./gate.js";
export { parseSnapshotMs } from "./freshness.js";
export {
  type EgressTarget,
  type EgressClaim,
  type ClaimValidationReason,
  validateEgressClaim,
  computeClaimKey,
} from "./egressClaim.js";
export {
  type SettledOutcome,
  type LedgerPhase,
  type LedgerEntry,
  type SingleUseLedger,
  type BeginResult,
  type BeginInput,
  type FinalizeReason,
  type FinalizeResult,
  type FinalizeInput,
  emptyLedger,
  statusOf,
  beginConsume,
  finalizeConsume,
} from "./singleUseLedger.js";
export {
  type ConnectOutcome,
  type Connector,
  type FenceChecker,
  type LedgerPort,
  type EnforcerOutcome,
  type AdmissionSignal,
  type EnforcerResult,
  type EgressEnforcer,
  type BrokerDependencies,
  BrokerEnforcer,
} from "./enforcer.js";
export {
  type AdmissionStore,
  type ClaimBindingRecord,
  type ClaimBindingStore,
  createInMemoryClaimBindingStore,
  type TcpCheckProviderDeps,
  type TcpCheckInput,
  type TcpCheckIdentity,
  type TcpCheckPreparedAttempt,
  type TcpCheckReceiptSummary,
  type TcpCheckProvider,
  TCP_CHECK_PROVIDER_NAME,
  DEFAULT_CONNECT_DEADLINE_MS,
  DEFAULT_CAPABILITY_LEASE_MS,
  TcpCheckRefused,
  TcpCheckNotCommissionedError,
  notCommissionedConnector,
  createInMemoryAdmissionStore,
  createTcpCheckProvider,
  createTcpCheckProviderFromEnv,
} from "./tcpCheckProvider.js";
export {
  type TcpCheckArguments,
  type OwnerResolver,
  type ApprovedDigestResolver,
  SECURITY_TOOL,
  TCP_CHECK_OPERATION,
  tcpCheckArgumentsSchema,
  createTcpCheckToolDefinition,
} from "./tcpCheckTool.js";
