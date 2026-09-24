import { readFileSync } from "node:fs";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  persistenceActionOutputShape,
  persistenceSettingsOutputShape,
  PERSISTENCE_ACTIONS,
} from "../settings/persistenceSettings.js";
import { JarvisApiError, type JarvisApiClient } from "./jarvisApiClient.js";

export const JARVIS_PERSISTENCE_SETTINGS_URI = "ui://jarvis/persistence-settings.html";

const persistenceHtml = readFileSync(
  new URL("./persistence-settings.html", import.meta.url),
  "utf8",
);

const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const actionAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function toolError(error: unknown) {
  const message =
    error instanceof JarvisApiError
      ? `${error.message}${error.requestId ? ` Request ID: ${error.requestId}.` : ""}`
      : "Jarvis preview could not complete the request.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function registerPersistenceSettingsTools(server: McpServer, client: JarvisApiClient): void {
  registerAppResource(
    server,
    "jarvis-persistence-settings",
    JARVIS_PERSISTENCE_SETTINGS_URI,
    {},
    async () => ({
      contents: [
        {
          uri: JARVIS_PERSISTENCE_SETTINGS_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: persistenceHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "Jarvis Settings → Persistence. Read-only provider display and backup commands. Not a second recovery authority.",
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "show_persistence_settings",
    {
      title: "Show Persistence settings",
      description:
        "Open Settings → Persistence. Shows the active JSON or Convex provider, health, and the classic and archive v4 backup commands. Does not switch providers.",
      inputSchema: {},
      outputSchema: persistenceSettingsOutputShape,
      annotations: readAnnotations,
      _meta: {
        ui: {
          resourceUri: JARVIS_PERSISTENCE_SETTINGS_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => {
      try {
        const settings = await client.getPersistenceSettings();
        return {
          structuredContent: { settings },
          content: [
            {
              type: "text" as const,
              text: settings.provider.misconfigured
                ? "Persistence provider is misconfigured. Jarvis will not silently fall back."
                : `Active persistence provider: ${settings.provider.active ?? "unset"}.`,
            },
          ],
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "run_persistence_settings_action",
    {
      title: "Run a Persistence settings action",
      description:
        "Operator Settings → Persistence only. Runs one existing npm run backup command after the page's explicit confirmation. Resume is never implied. Do not call unless Benny used the Persistence page.",
      inputSchema: {
        action: z.enum(PERSISTENCE_ACTIONS),
        file: z.string().optional(),
        destination: z.string().optional(),
        confirmEmptyTarget: z.boolean().optional(),
        understandIdsRecreated: z.boolean().optional(),
        allowPartial: z.boolean().optional(),
        acknowledgePartial: z.boolean().optional(),
        resume: z.boolean().optional(),
        typedConfirmation: z.string().optional(),
      },
      outputSchema: persistenceActionOutputShape,
      annotations: actionAnnotations,
      _meta: {
        ui: {
          resourceUri: JARVIS_PERSISTENCE_SETTINGS_URI,
          visibility: ["app"],
        },
      },
    },
    async (input) => {
      try {
        const result = await client.runPersistenceSettingsAction(input);
        return {
          structuredContent: { result },
          content: [{ type: "text" as const, text: result.detail }],
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );
}
