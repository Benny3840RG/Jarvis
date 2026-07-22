import { z } from "zod";

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

export const systemSchema = z.object({
  label: z.string(),
  value: z.string(),
  state: z.enum(["good", "guarded", "pending"]),
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
  tasks: z.array(taskSchema),
  reminders: z.array(reminderSchema),
  systems: z.array(systemSchema),
  activity: z.array(z.string()),
  counts: z.object({
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    reminders: z.number().int().nonnegative(),
  }),
});

export type JarvisTask = z.infer<typeof taskSchema>;
export type JarvisReminder = z.infer<typeof reminderSchema>;
export type JarvisConsoleProps = z.infer<typeof propSchema>;
