import { z } from "zod";

export const propSchema = z.object({
  title: z.string(),
  phase: z.string(),
  deployment: z.string(),
  environment: z.string(),
  status: z.enum(["operational", "degraded", "offline"]),
  mission: z.string(),
  progress: z.number().min(0).max(100),
  tasks: z.array(
    z.object({
      label: z.string(),
      state: z.enum(["complete", "active", "queued"]),
    })
  ),
  systems: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      state: z.enum(["good", "guarded", "pending"]),
    })
  ),
  activity: z.array(z.string()),
});

export type JarvisConsoleProps = z.infer<typeof propSchema>;
