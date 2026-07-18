import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { startJarvisMcpHttpServer } from "../src/mcp/httpServer.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe("Jarvis MCP HTTP boundary", () => {
  it("serves a local health endpoint without exposing credentials", async () => {
    const config: JarvisMcpConfig = {
      host: "127.0.0.1",
      port: await freePort(),
      api: {
        baseUrl: new URL("http://127.0.0.1:3000/"),
        serviceToken: "never-print-this-token",
      },
    };
    const client = new JarvisApiClient(config.api, (async () => {
      throw new Error("The health endpoint must not call Jarvis HTTP.");
    }) as typeof fetch);
    const running = await startJarvisMcpHttpServer(config, client);
    try {
      const response = await fetch(running.url.replace(/\/mcp$/, "/"));
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /jarvis-mcp-preview/);
      assert.doesNotMatch(body, /never-print-this-token/);
    } finally {
      await running.close();
    }
  });
});
