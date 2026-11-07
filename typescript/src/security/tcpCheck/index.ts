// Public surface of the Stage 3 `security:tcp-check` pure core (Phase 1). These
// modules perform no I/O and no network effect; admission control, the egress
// enforcer, governed wiring, and the socket effect land in later phases
// (see issue #779). Nothing here opens a socket.

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
