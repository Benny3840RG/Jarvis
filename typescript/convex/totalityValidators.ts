import { v } from "convex/values";

export const projectStatusValidator = v.union(
  v.literal("planned"),
  v.literal("active"),
  v.literal("blocked"),
  v.literal("completed"),
  v.literal("archived"),
);

export const projectPreferencesValidator = v.object({
  outputStyle: v.string(),
  communicationTone: v.string(),
  detailLevel: v.string(),
  unitSystem: v.literal("metric"),
  locale: v.literal("en-AU"),
});

export const projectValidator = v.object({
  _id: v.id("projects"),
  _creationTime: v.number(),
  ownerId: v.string(),
  projectKey: v.string(),
  projectName: v.string(),
  projectType: v.string(),
  status: projectStatusValidator,
  createdAt: v.string(),
  updatedAt: v.string(),
  revision: v.number(),
  domains: v.array(v.string()),
  summary: v.string(),
  preferences: projectPreferencesValidator,
});

const impactValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));

export const recordKindValidator = v.union(
  v.literal("component"),
  v.literal("fact"),
  v.literal("assumption"),
  v.literal("constraint"),
  v.literal("measurement"),
  v.literal("decision"),
  v.literal("risk"),
  v.literal("task"),
  v.literal("event"),
);

const componentRecordValidator = v.object({
  kind: v.literal("component"),
  recordId: v.string(),
  name: v.string(),
  type: v.string(),
  status: v.string(),
  parentComponentId: v.union(v.string(), v.null()),
  attributes: v.record(v.string(), v.any()),
  notes: v.string(),
});

const factRecordValidator = v.object({
  kind: v.literal("fact"),
  recordId: v.string(),
  statement: v.string(),
  source: v.union(
    v.literal("user"),
    v.literal("file"),
    v.literal("tool"),
    v.literal("measurement"),
    v.literal("inference"),
  ),
  confidence: v.number(),
  recordedAt: v.string(),
});

const assumptionRecordValidator = v.object({
  kind: v.literal("assumption"),
  recordId: v.string(),
  statement: v.string(),
  status: v.union(v.literal("unverified"), v.literal("verified"), v.literal("rejected")),
  impact: impactValidator,
});

const constraintRecordValidator = v.object({
  kind: v.literal("constraint"),
  recordId: v.string(),
  type: v.union(
    v.literal("budget"),
    v.literal("time"),
    v.literal("access"),
    v.literal("material"),
    v.literal("tool"),
    v.literal("legal"),
    v.literal("safety"),
    v.literal("dimensional"),
  ),
  value: v.any(),
  hardConstraint: v.boolean(),
});

const measurementRecordValidator = v.object({
  kind: v.literal("measurement"),
  recordId: v.string(),
  name: v.string(),
  value: v.number(),
  unit: v.string(),
  tolerance: v.optional(v.string()),
  source: v.string(),
});

const decisionRecordValidator = v.object({
  kind: v.literal("decision"),
  recordId: v.string(),
  decision: v.string(),
  rationale: v.string(),
  alternativesRejected: v.array(v.string()),
  timestamp: v.string(),
});

const riskRecordValidator = v.object({
  kind: v.literal("risk"),
  recordId: v.string(),
  hazard: v.string(),
  likelihood: v.number(),
  consequence: v.number(),
  controls: v.array(v.string()),
  residualRisk: impactValidator,
});

const taskRecordValidator = v.object({
  kind: v.literal("task"),
  recordId: v.string(),
  title: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("blocked"),
    v.literal("done"),
  ),
  dependencies: v.array(v.string()),
  owner: v.string(),
  dueAt: v.union(v.string(), v.null()),
});

const eventRecordValidator = v.object({
  kind: v.literal("event"),
  recordId: v.string(),
  eventType: v.string(),
  actor: v.union(v.literal("user"), v.literal("agent"), v.literal("tool")),
  timestamp: v.string(),
  payload: v.record(v.string(), v.any()),
});

export const projectRecordValidator = v.union(
  componentRecordValidator,
  factRecordValidator,
  assumptionRecordValidator,
  constraintRecordValidator,
  measurementRecordValidator,
  decisionRecordValidator,
  riskRecordValidator,
  taskRecordValidator,
  eventRecordValidator,
);

export const projectRecordDocumentValidator = v.object({
  _id: v.id("projectRecords"),
  _creationTime: v.number(),
  ownerId: v.string(),
  projectKey: v.string(),
  kind: recordKindValidator,
  recordId: v.string(),
  record: projectRecordValidator,
  updatedAt: v.number(),
});

export const validationCheckValidator = v.object({
  id: v.string(),
  status: v.union(v.literal("pass"), v.literal("warning"), v.literal("fail")),
  message: v.optional(v.string()),
});

export const validationReportValidator = v.object({
  _id: v.id("validationReports"),
  _creationTime: v.number(),
  ownerId: v.string(),
  requestId: v.string(),
  scopeKey: v.string(),
  passed: v.boolean(),
  checks: v.array(validationCheckValidator),
  warnings: v.array(v.string()),
  blockingFailures: v.array(v.string()),
  createdAt: v.number(),
});

export const auditEventValidator = v.object({
  _id: v.id("auditEvents"),
  _creationTime: v.number(),
  ownerId: v.string(),
  requestId: v.optional(v.string()),
  scopeKey: v.string(),
  eventType: v.string(),
  actor: v.union(v.literal("user"), v.literal("agent"), v.literal("tool")),
  payload: v.record(v.string(), v.any()),
  createdAt: v.number(),
});
