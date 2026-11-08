// Independently trusted integrity anchor for the vendored special-use table
// (design R2/R3; #779 obligation on table integrity). This digest is committed
// **separately** from the table contents in `specialUseTable.ts`: changing the
// table without updating this constant in the same reviewed PR makes the loader
// fail closed (deny-all), and an edit to both is caught in code review. Git
// review and history are the trust root — the anchor does not travel with the
// table, so a table modified together with a self-declared digest cannot pass.
//
// To refresh after an intentional, reviewed table change, recompute with:
//   node --import tsx -e "import('./src/security/tcpCheck/specialUseTable.js') \
//     .then(m => console.log(m.computeSpecialUseTableDigest()))"
// and paste the value below.
// Refreshed 2026-11-09 for the table revision adding IPv4 multicast (224.0.0.0/4)
// and the deprecated IPv4-compatible IPv6 range (::/96), and the snapshot-date bump.
export const TRUSTED_SPECIAL_USE_TABLE_DIGEST =
  "028373f63eb8da270676b21d3a7277fc21dded9ccc22b028eebee67c32b7e7c5";
