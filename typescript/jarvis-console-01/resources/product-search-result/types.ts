import { z } from "zod";

import { consolePaginationInvariantIssues } from "../../pagination.js";

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  category: z.string(),
  createdAt: z.number(),
});

export const reminderSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueRaw: z.string().optional(),
  dueAt: z.number().optional(),
  dueTimezone: z.string().optional(),
  createdAt: z.number(),
});

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  domain: z.enum(["business", "home", "workshop", "shared"]),
  sensitivity: z.enum(["internal", "private", "secret"]),
  createdAt: z.number(),
});

export const systemSchema = z.object({
  label: z.string(),
  value: z.string(),
  state: z.enum(["good", "guarded", "pending"]),
});

const paginationMetaSchema = z.object({
  isDone: z.boolean(),
  continueCursor: z.string(),
  returnedCount: z.number().int().nonnegative(),
  requestedPageSize: z.number().int().min(1).max(100),
});

export const propSchema = z.object({
  title: z.string(),
  phase: z.string(),
  deployment: z.string(),
  environment: z.string(),
  status: z.enum(["operational", "degraded", "offline"]),
  mission: z.string(),
  progress: z.number().min(0).max(100),
  lastUpdated: z.number(),
  tasks: z.array(taskSchema).max(100),
  reminders: z.array(reminderSchema).max(100),
  notes: z.array(noteSchema).max(100),
  systems: z.array(systemSchema),
  activity: z.array(z.string()),
  counts: z.object({
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    reminders: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    tasksPartial: z.boolean(),
    remindersPartial: z.boolean(),
    notesPartial: z.boolean(),
  }),
  pagination: z.object({
    tasks: paginationMetaSchema,
    reminders: paginationMetaSchema,
    notes: paginationMetaSchema,
  }),
}).superRefine((value, ctx) => {
  for (const issue of consolePaginationInvariantIssues(value)) {
    ctx.addIssue({ code: "custom", ...issue });
  }
});

export type JarvisTask = z.infer<typeof taskSchema>;
export type JarvisReminder = z.infer<typeof reminderSchema>;
export type JarvisNote = z.infer<typeof noteSchema>;
export type JarvisConsoleProps = z.infer<typeof propSchema>;
