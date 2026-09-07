// Pure selection logic for the autonomous-build queue-advance workflow.
//
// No I/O and no GitHub API calls: the workflow gathers issues and pull requests
// and passes them here. The gates below mirror the eligibility check in
// .github/workflows/jarvis-autobuild.yml so the queue never dispatches a mission
// the bounded builder would immediately reject, and never runs more than one
// mission at a time.

const AUTOMATION_BRANCH_REF = /^automation\/issue-(\d+)\/run-[A-Za-z0-9._-]+$/;

/**
 * Extract the issue number from an autonomous-build head ref
 * (`automation/issue-<n>/run-<run-id>`). Returns null for any other ref.
 */
export function parseAutomationIssueRef(headRef) {
  const match = AUTOMATION_BRANCH_REF.exec(String(headRef ?? "").trim());
  if (!match) return null;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/** Collapse a list of head refs to the set of issue numbers they belong to. */
export function automationIssueNumbers(headRefs = []) {
  const numbers = new Set();
  for (const ref of headRefs) {
    const parsed = parseAutomationIssueRef(ref);
    if (parsed !== null) numbers.add(parsed);
  }
  return numbers;
}

function labelSet(issue) {
  return new Set(
    (issue?.labels ?? []).map((label) =>
      typeof label === "string" ? label : String(label?.name ?? ""),
    ),
  );
}

/**
 * Decide whether a single approved issue may be dispatched now.
 * `openAutomationIssueNumbers` is the set of issue numbers that already have an
 * open automation candidate pull request.
 */
export function evaluateQueueCandidate(
  issue,
  { openAutomationIssueNumbers = new Set() } = {},
) {
  const reasons = [];
  const labels = labelSet(issue);
  const body = String(issue?.body ?? "");
  const number = Number(issue?.number);

  if (!Number.isSafeInteger(number) || number <= 0) {
    reasons.push("issue number is invalid");
  }
  if (issue?.state !== "open") reasons.push("issue is not open");
  if (issue?.pull_request) reasons.push("target is a pull request, not an issue");
  if (!labels.has("automation-approved")) {
    reasons.push("automation-approved label is missing");
  }
  if (labels.has("automation-blocked")) {
    reasons.push("automation-blocked label is present");
  }
  if (labels.has("automation-in-progress")) {
    reasons.push("automation-in-progress lock is already present");
  }
  if (
    Number.isSafeInteger(number) &&
    number > 0 &&
    openAutomationIssueNumbers.has(number)
  ) {
    reasons.push("an automation pull request already exists");
  }
  const hasAcceptanceHeading = /^#{1,6}\s+acceptance criteria\s*$/im.test(body);
  const hasChecklistItem = /^\s*-\s*\[[ xX]\]\s+\S+/m.test(body);
  if (!hasAcceptanceHeading || !hasChecklistItem) {
    reasons.push("testable acceptance criteria are missing");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Select the single next mission to dispatch, or none.
 *
 * - `lockActive` is true when any issue currently carries `automation-in-progress`.
 * - `openAutomationPrHeadRefs` are the head refs of every open pull request in
 *   this repository; automation candidate PRs among them halt the queue.
 *
 * Returns `{ issue, skipped, blocked }`. `blocked` is true when a mission is
 * already active (nothing is dispatched and no lock is touched). Otherwise
 * `issue` is the lowest-numbered eligible issue, or null when the queue is
 * drained. `skipped` lists every ineligible candidate with its reasons.
 */
export function selectNextMission({
  issues = [],
  openAutomationPrHeadRefs = [],
  lockActive = false,
} = {}) {
  const openAutomationIssueNumbers = automationIssueNumbers(openAutomationPrHeadRefs);
  const skipped = [];

  if (lockActive || openAutomationIssueNumbers.size > 0) {
    return {
      issue: null,
      skipped,
      blocked: true,
      reason: "another autonomous-build mission is already active",
    };
  }

  const eligible = [];
  for (const issue of issues) {
    const evaluation = evaluateQueueCandidate(issue, { openAutomationIssueNumbers });
    if (evaluation.ok) {
      eligible.push(issue);
    } else {
      skipped.push({
        number: Number.isSafeInteger(Number(issue?.number))
          ? Number(issue.number)
          : null,
        reasons: evaluation.reasons,
      });
    }
  }

  eligible.sort((a, b) => Number(a.number) - Number(b.number));
  return { issue: eligible[0] ?? null, skipped, blocked: false };
}
