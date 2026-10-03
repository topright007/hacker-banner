// Deterministic, local-only stdio MCP fixture for the real OpenCode smoke test.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "sensor-fixture", version: "1.0.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "MCP_DESCRIPTION_SENTINEL: local test tool; returns the supplied text.",
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string" }, text: { type: "string" } },
              required: ["marker", "text"],
            },
          },
        ],
      };
      break;
    case "tools/call":
      await writeFile(request.params.arguments.marker, "executed");
      result = {
        content: [
          { type: "text", text: request.params.arguments.text },
          {
            type: "resource",
            resource: {
              uri: "fixture://private-result",
              mimeType: "text/plain",
              text: request.params.arguments.text,
            },
          },
        ],
        structuredContent: { privateResult: request.params.arguments.text },
        _meta: { privateResult: request.params.arguments.text },
      };
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Unknown fixture method" },
        }) + "\n",
      );
      continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
