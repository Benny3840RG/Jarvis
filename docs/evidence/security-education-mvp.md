# #732 education-only MVP — design and review handoff

Owner instruction: Codex builds #732 independently of open maintenance PR #746; Claude reviews.
The issue's coordination comment records the exception. Base:
`1c5d8255fc27d51329e3009499c0d9e02b61444e`.
Branch: `agent/issue-732-security-education`.

## Implementation approach and threat model

1. Register exactly `security:explain` and `security:interpret` in the existing explicit
   ToolExecution factory. T1 minimum; use existing staging, approval, safety, execution
   eligibility, consumption policy, fingerprints, timeouts and receipt replay.
2. Fixed local catalogue (six concepts) and a deliberately narrow parser for supplied
   port-state excerpts. No model, filesystem, shell, network or dependency injection
   capable of external effects is available to these handlers.
3. The authoritative Convex stage mutation minimises input before persistence, even for
   callers bypassing the HTTP adapter. Service labels disappear; unsupported data becomes
   a fixed marker. Audit payloads remain metadata-only. No pasted text is echoed in answers.
4. Existing execute returns only a digest. Add an optional **transient** `education` result
   to its response, reconstructed only for registered educational operations with a
   successful matching action fingerprint and output digest. No arbitrary executor output
   channel, persisted result, schema migration or backup-format change.
5. Keep action-family lifecycle planned. No commissioning, production changes or intrusive
   capabilities. Stage 3 diagnostics and stage 4 labs need separate designs and approvals.

Trust boundaries: caller input is untrusted; the lesson catalogue and parser are reviewed
code; only existing owner/project and approval services grant authority. Claimed diagnostic
rows remain unverified observations. A pasted "ignore instructions" line is unsupported data.
Addresses, paths and commands have no execution channel. Unknown report formats are not
partially interpreted. Combined port states are explicitly uncertain, not "safe" or "vulnerable".

Privacy: valid rows retain only port, transport and state in proposals; all unsupported text
is discarded. Receipt outputs remain digest-only. User-supplied rationale and other existing
metadata still must not contain secrets. The boundary does not claim universal secret detection.
No new retention policy or external data transfer is introduced.

## Focused proof

Tests first: the new education test failed with a missing module before implementation.
The three added authoritative staging tests failed against the unchanged mutation (35 existing
consent tests passed), proving the raw-data storage and unknown-operation gaps.

Validation commands, from `typescript/`:

- `node --import tsx --test tests/securityEducation.test.ts tests/toolActionHttp.test.ts`
- `npx --no-install vitest run --config vitest.config.mts --maxWorkers=1 convex/toolActions.test.ts`
- `node scripts/validate-action-map.mjs`
- `npm run check`
- `npm run openapi:lint`

Coverage includes bounded and invalid inputs, extra target/command keys, IPv4/IPv6/path/URL
text, injection, credential-bearing lines, ANSI escapes, duplicate/excessive rows, uncertainty,
proposal minimisation and idempotent staging, approval/authority/expiry/eligibility refusal,
dry-run, cancellation before parsing, fingerprint collision, fresh-service replay, mismatching
output digests, no persisted readable answer and the authenticated HTTP response.

Live DNS/network, shell, symlink, provider and target tests are inapplicable because those
adapters do not exist in this stage. No live Convex sync/smoke, commissioning, device access,
model call, email, service restart, merge or deployment was performed. Local Convex tests
exercise the mutation in an isolated test harness.

Independent review: Claude must review the final exact SHA, including unchanged approval,
HTTP and receipt boundaries. Required exact-head CI and Jarvis evidence remain separate.
Neither this document nor passing tests are a peer review, PASS or deployment authorisation.
See the draft PR for final candidate identity and observed validation results.

Generated action map: Ruby is unavailable in this development environment. An equivalent
local renderer first reproduced the base generated file byte-for-byte, then rendered the
new entries. The unchanged Ruby generator/check remains required in GitHub governance CI.

Collision avoidance: #746 also edits the shared TypeScript ROADMAP. This branch
leaves that file untouched and records progress in this dedicated design/evidence
record and the new operator guide instead. Reconcile the shared roadmap only
after the other mission is terminal.

## Local validation outcome

- Focused Node/HTTP/allowlist run: 49 passed, zero failures.
- Authoritative Convex tool-action suite: 38 passed, zero failures.
- TypeScript application and Convex type checks, ESLint, Prettier, OpenAPI lint
  and repository hygiene passed in the final full-check attempt.
- Action-map schema, reference and semantic validation passed.
- `npm run check` could not be established green here: unchanged
  `tests/acpUnixSocketEgress.test.ts` reports three socket scenario failures and
  retains handles. A bounded isolated rerun reproduced those failures; a direct
  AF_UNIX socket probe raised EPERM. No socket test, approval or sandbox was
  disabled. Full-suite Linux CI and the Ruby generated-map check remain pending.

This is development evidence for a draft, not a claim that every required gate passed.
