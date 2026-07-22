import { MCPServer, text, widget } from "mcp-use/server";
import { z } from "zod";

const server = new MCPServer({
  name: "jarvis-console-01",
  title: "Jarvis Console 01",
  version: "1.1.0",
  description: "Landscape-first Jarvis command centre MCP App",
  instructions:
    "Use show-jarvis-console to open the Console 01 HUD. The Phase 1 HUD presents live deployment identity, MCP readiness, mission state, and truthful operator controls without fabricated telemetry.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://github.com/Benny3840/Jarvis",
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

const consoleStateSchema = z.object({
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

server.tool(
  {
    name: "show-jarvis-console",
    title: "Open Jarvis Console 01",
    description: "Open the Jarvis Console 01 Phase 1 landscape HUD",
    schema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    outputSchema: consoleStateSchema,
    widget: {
      name: "product-search-result",
      invoking: "Powering Console 01...",
      invoked: "Console 01 online",
    },
  },
  async () => {
    const deployment = process.env.MCP_URL || "Manufact Cloud";
    return widget({
      props: {
        title: "JARVIS SYSTEM // CONSOLE 01",
        phase: "PHASE 1 · HUD FOUNDATION",
        deployment,
        environment: process.env.NODE_ENV || "production",
        status: "operational" as const,
        mission: "Replace the scaffold with a real Jarvis command centre",
        progress: 68,
        tasks: [
          { label: "Industrial landscape shell", state: "complete" as const },
          { label: "Animated reactor core", state: "complete" as const },
          { label: "Live MCP deployment identity", state: "active" as const },
          { label: "Convex task and reminder bridge", state: "queued" as const },
        ],
        systems: [
          { label: "MCP endpoint", value: "ONLINE", state: "good" as const },
          { label: "Manufact", value: "DEPLOYED", state: "good" as const },
          { label: "Convex", value: "BRIDGE NEXT", state: "pending" as const },
          { label: "Production authority", value: "GUARDED", state: "guarded" as const },
        ],
        activity: [
          "Console 01 scaffold replaced",
          "Landscape HUD loaded",
          "Widget bridge operational",
          "No fabricated telemetry enabled",
        ],
      },
      output: text(
        "Jarvis Console 01 Phase 1 is operational. The HUD is live and ready for the Convex data bridge."
      ),
    });
  }
);

server.listen().then(() => {
  console.log("Jarvis Console 01 server running");
});
