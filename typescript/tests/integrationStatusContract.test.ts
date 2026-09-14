import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

async function mcpSchema(): Promise<JsonSchemaType> {
  const server = createJarvisMcpServer(
    new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "status-contract-test" },
      async () => {
        throw new Error("Schema inspection must not call the API");
      },
    ),
  );
  const client = new Client({ name: "status-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === "get_jarvis_status",
    );
    assert.ok(tool?.outputSchema);
    const output = tool.outputSchema as unknown as {
      properties: { status: { properties: { integrations: { items: JsonSchemaType } } } };
    };
    return output.properties.status.properties.integrations.items;
  } finally {
    await client.close();
    await server.close();
  }
}

for (const surface of ["OpenAPI", "MCP"] as const) {
  it(`${surface} enforces integration stage, status and reason together`, async () => {
    const schema: JsonSchemaType =
      surface === "MCP"
        ? await mcpSchema()
        : JSON.parse(
            await readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
          ).components.schemas.IntegrationStatus;
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    for (const stage of ["implemented", "configured", "commissioned", "production-approved"]) {
      for (const status of ["commissioned", "not-commissioned"]) {
        for (const reason of [undefined, "", "Evidence is unavailable here."]) {
          const value = {
            name: "quote-delivery",
            stage,
            status,
            ...(reason === undefined ? {} : { reason }),
          };
          const commissioned = stage === "commissioned" || stage === "production-approved";
          const expected =
            status === (commissioned ? "commissioned" : "not-commissioned") &&
            (stage === "production-approved"
              ? reason === undefined || reason.length > 0
              : typeof reason === "string" && reason.length > 0);
          assert.equal(validate(value).valid, expected, JSON.stringify(value));
        }
      }
    }
  });
}
