// Public surface of the Stage 3 `security:tcp-check` core (Phases 1–2). These
// modules perform no I/O and no network effect: Phase 1 is the pure policy core
// and Phase 2 is the pure admission state machine. The egress enforcer, governed
// wiring, and the socket effect land in later phases (see issue #779). Nothing
// here opens a socket.

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
} from "./admission.js";
