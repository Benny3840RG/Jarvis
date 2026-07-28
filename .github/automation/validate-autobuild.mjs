const MAX_CHANGED_FILES = 30;
const MAX_DIFF_LINES = 2_000;

const FORBIDDEN_PATHS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^\.github\/automation\//,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)package(?:-lock)?\.json$/,
  /^typescript\/convex\/schema\.ts$/,
  /(^|\/)convex\.json$/,
];

const SOURCE_PATH = /^(?:typescript\/src\/|typescript\/convex\/).+\.ts$/;
const TEST_PATH =
  /^(?:typescript\/tests\/.*\.test\.ts|typescript\/convex\/.*\.test\.ts|typescript\/jarvis-console-01\/tests\/.*\.test\.ts)$/;

function result(reasons) {
  return { ok: reasons.length === 0, reasons };
}

function labelsOf(issue) {
  return new Set(
    (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : String(label?.name ?? ""),
    ),
  );
}

export function evaluateIssue(issue) {
  const reasons = [];
  const labels = labelsOf(issue);
  const body = String(issue.body ?? "");
  const hasAcceptanceHeading = /^#{1,6}\s+acceptance criteria\s*$/im.test(body);
  const hasChecklistItem = /^\s*-\s*\[[ xX]\]\s+\S+/m.test(body);

  if (issue.state !== "open") reasons.push("issue is not open");
  if (!labels.has("automation-approved")) reasons.push("automation-approved label is missing");
  if (labels.has("automation-in-progress")) {
    reasons.push("automation-in-progress lock is already present");
  }
  if (issue.hasExistingAutomationPr) reasons.push("automation pull request already exists");
  if (!hasAcceptanceHeading || !hasChecklistItem) {
    reasons.push("testable acceptance criteria are missing");
  }

  return result(reasons);
}

function forbiddenPathReason(path) {
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(path))
    ? `forbidden path changed: ${path}`
    : null;
}

export function evaluateDiff({ files = [] } = {}) {
  const reasons = [];

  if (files.length === 0) reasons.push("no repository changes were produced");
  if (files.length > MAX_CHANGED_FILES) reasons.push("changed file limit exceeded");

  const changedLines = files.reduce(
    (total, file) => total + Number(file.additions ?? 0) + Number(file.deletions ?? 0),
    0,
  );
  if (changedLines > MAX_DIFF_LINES) reasons.push("diff line limit exceeded");

  for (const file of files) {
    const path = String(file.path ?? "");
    const pathReason = forbiddenPathReason(path);
    if (pathReason) reasons.push(pathReason);
    if (file.binary) reasons.push(`binary change is forbidden: ${path}`);
    if (file.symlink) reasons.push(`symlink change is forbidden: ${path}`);
  }

  const sourceChanged = files.some(
    (file) => SOURCE_PATH.test(String(file.path ?? "")) && !TEST_PATH.test(String(file.path ?? "")),
  );
  const testChanged = files.some((file) => TEST_PATH.test(String(file.path ?? "")));
  if (sourceChanged && !testChanged) {
    reasons.push("source changes require a matching test change");
  }

  return result([...new Set(reasons)]);
}

export function redactReceipt(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(
      /((?:OPENAI_API_KEY|JARVIS_SERVICE_TOKEN|CONVEX_DEPLOY_KEY)\s*[:=]\s*)[^\s"',]+/gi,
      "$1[REDACTED]",
    );
}

function requirePatterns(text, requirements) {
  const reasons = [];
  for (const [description, pattern] of requirements) {
    if (!pattern.test(text)) reasons.push(description);
  }
  return result(reasons);
}

export function validatePromptContract(prompt) {
  return requirePatterns(String(prompt ?? ""), [
    ["prompt must classify issue content as untrusted", /issue content.*untrusted/i],
    ["prompt must limit work to one approved issue", /one approved issue only/i],
    ["prompt must forbid workflow changes", /do not change[\s\S]*workflows/i],
    ["prompt must forbid secret changes", /do not change[\s\S]*secrets/i],
    ["prompt must forbid permission changes", /do not change[\s\S]*permissions/i],
    ["prompt must forbid dependency changes", /do not change[\s\S]*dependencies/i],
    ["prompt must forbid schema changes", /do not change[\s\S]*schema/i],
    ["prompt must forbid commissioning", /do not change[\s\S]*commissioning/i],
    ["prompt must forbid merging", /do not change[\s\S]*merging/i],
    ["prompt must forbid deployment", /do not change[\s\S]*deployment/i],
    ["prompt must require tests first", /tests before implementation/i],
    ["prompt must require the Jarvis checks", /npm run check/i],
    ["prompt must cover the console build", /build Jarvis Console/i],
    ["prompt must stop on ambiguity or scope expansion", /stop.*ambiguous.*broader scope/i],
    ["prompt must forbid git publication", /do not commit, push, create pull requests/i],
    ["prompt must forbid external actions", /external actions/i],
  ]);
}

export function validateWorkflowContract(workflow) {
  const text = String(workflow ?? "");
  const requirements = [
    ["workflow must trigger on labelled issues", /issues:[\s\S]*types:\s*\[labeled\]/i],
    ["workflow must support manual dispatch", /workflow_dispatch:/i],
    ["workflow must require automation-approved", /automation-approved/i],
    ["workflow must define concurrency", /concurrency:/i],
    ["workflow must not cancel an in-progress build", /cancel-in-progress:\s*false/i],
    ["workflow must have a finite timeout", /timeout-minutes:\s*[1-9]\d*/i],
    ["workflow must declare permissions", /permissions:/i],
    ["workflow must allow branch writes", /contents:\s*write/i],
    ["workflow must allow issue receipts", /issues:\s*write/i],
    ["workflow must allow draft PR creation", /pull-requests:\s*write/i],
    [
      "Codex action must be pinned to an immutable SHA",
      /openai\/codex-action@[0-9a-f]{40}\b/i,
    ],
    [
      "OpenAI key must come from Actions secrets",
      /openai-api-key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/i,
    ],
    ["Codex must use workspace permissions", /permission-profile:\s*[\"']?:workspace[\"']?/i],
    ["Codex must drop sudo", /safety-strategy:\s*drop-sudo/i],
    ["workflow must create a draft PR", /(?:draft:\s*true|--draft\b)/i],
    ["workflow must always clean up", /if:\s*always\(\)/i],
  ];

  const checked = requirePatterns(text, requirements);
  const reasons = [...checked.reasons];
  if (/\b(?:merge|deploy|commission)\b.*(?:--|run|create|execute)/i.test(text)) {
    reasons.push("workflow contains a prohibited merge, deploy, or commission command");
  }
  if (/^\s*environment:\s*/m.test(text)) reasons.push("workflow must not target an environment");

  return result([...new Set(reasons)]);
}
