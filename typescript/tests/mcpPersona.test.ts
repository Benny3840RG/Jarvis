import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import {
  JARVIS_INSTRUCTIONS,
  JARVIS_PERSONA_MARKDOWN,
  JARVIS_PERSONA_URI,
} from "../src/mcp/persona.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

function unusedFetch(): typeof fetch {
  return (async () => {
    throw new Error("the network must not be reached in persona tests");
  }) as typeof fetch;
}

async function connectedClient() {
  const apiClient = new JarvisApiClient(
    { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "persona-test-token" },
    unusedFetch(),
  );
  const server = createJarvisMcpServer(apiClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "jarvis-persona-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("Jarvis persona", () => {
  it("delivers the persona brief as server instructions on initialize", async () => {
    const { client, server } = await connectedClient();
    try {
      const instructions = client.getInstructions();
      assert.equal(instructions, JARVIS_INSTRUCTIONS);
      // The always-on brief must carry the identity and the honesty anchors.
      assert.match(instructions ?? "", /Jarvis/);
      assert.match(instructions ?? "", /Beez Treez/);
      assert.match(instructions ?? "", /no phone GPS|geofencing/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves the full persona charter as a readable markdown resource", async () => {
    const { client, server } = await connectedClient();
    try {
      const listed = await client.listResources();
      assert.ok(
        listed.resources.some((resource) => resource.uri === JARVIS_PERSONA_URI),
        "the persona resource must be advertised.",
      );

      const read = await client.readResource({ uri: JARVIS_PERSONA_URI });
      assert.equal(read.contents.length, 1);
      const [content] = read.contents;
      assert.equal(content.uri, JARVIS_PERSONA_URI);
      assert.equal(content.mimeType, "text/markdown");
      assert.ok("text" in content, "the persona resource must be text, not a blob.");
      assert.equal(content.text, JARVIS_PERSONA_MARKDOWN);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the honesty guardrails in the charter itself", () => {
    // These are the bespoke, non-negotiable limits; a future edit that drops
    // them should break the build, not ship silently.
    assert.match(JARVIS_PERSONA_MARKDOWN, /no phone GPS|geofencing/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /safety equipment/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /server-computed|computed by the system|totals/i);
  });
});
