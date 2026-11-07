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
export const TRUSTED_SPECIAL_USE_TABLE_DIGEST =
  "aaea5a29f9d50c7d9e1c07d0bbd94573a7549c8e0fa4ed636127a606ff5e6226";
