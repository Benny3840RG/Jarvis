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
      // ...the advisory remit that makes Jarvis a shed engineer...
      assert.match(instructions ?? "", /shed engineer|fabrication/i);
      assert.match(instructions ?? "", /safety guardian/i);
      // ...and the advisory-honesty line that keeps that remit truthful.
      assert.match(instructions ?? "", /datasheet|test|professional/i);
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
    assert.match(
      JARVIS_PERSONA_MARKDOWN,
      /computed by the system|the system does the sums|totals/i,
    );
    // The advisory remit stays honest: judgement, not a device, and it defers
    // to a real test or a licensed professional when the job demands one.
    assert.match(JARVIS_PERSONA_MARKDOWN, /judgement, not certified safety gear|not a device/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /licensed professional/i);
  });

  it("declares the shed-engineer advisory remit in the charter", () => {
    // The reasoning surface Benny asked for is a first-class part of the voice.
    assert.match(JARVIS_PERSONA_MARKDOWN, /Fabrication & CAD/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /RC & robotics/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /Electrical/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /Gardening & landscaping/i);
    assert.match(JARVIS_PERSONA_MARKDOWN, /mate-in-the-shed/i);
  });

  it("records the five durable-memory domains in the charter", () => {
    // Each of these maps to a shipped store->HTTP->MCP domain; the charter must
    // name what Jarvis actually keeps, so the voice can never drift from the
    // capabilities behind it.
    assert.match(JARVIS_PERSONA_MARKDOWN, /\*\*Builds\*\*/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /\*\*Build log\*\*/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /\*\*Upgrade chronicle\*\*/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /\*\*Assets & maintenance\*\*/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /\*\*Preferences\*\*/);
    // And the same domains are named in the always-on brief.
    assert.match(JARVIS_INSTRUCTIONS, /builds/i);
    assert.match(JARVIS_INSTRUCTIONS, /upgrade chronicle/i);
    assert.match(JARVIS_INSTRUCTIONS, /maintenance/i);
    assert.match(JARVIS_INSTRUCTIONS, /preferences/i);
    // Kept honest: recalled from what he logs, not sensed live.
    assert.match(JARVIS_PERSONA_MARKDOWN, /recalled from what Benny has logged/i);
  });
});
