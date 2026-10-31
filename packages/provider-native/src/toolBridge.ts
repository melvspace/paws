import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ChatTurn } from "@paws/provider-core";
import { chatTools, type ChatToolRuntime } from "./chatTools.ts";

// Short-lived, authenticated loopback MCP endpoint. Only container-backed tools exist here.
export async function openToolBridge(turn: ChatTurn, runtime: ChatToolRuntime) {
  const token = randomBytes(32).toString("hex");
  const entries = chatTools(turn, runtime);
  const tools = entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: z.toJSONSchema(entry.schema),
  }));
  const server = createServer(async (request, response) => {
    if (
      request.headers.origin ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end();

      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();

      return;
    }

    let id: string | number | null = null;

    try {
      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Too large");
      }

      const message = z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional(),
        })
        .parse(JSON.parse(body));
      id = message.id ?? null;

      if (message.id === undefined) {
        response.writeHead(202).end();

        return;
      }

      let result: unknown;

      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "paws", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = { tools };
      } else if (message.method === "tools/call") {
        turn.signal.throwIfAborted();
        const input = z
          .object({ name: z.string(), arguments: z.unknown() })
          .parse(message.params);
        const tool = entries.find((entry) => entry.name === input.name);

        if (!tool) throw new Error("Unknown tool");

        result = await tool.execute(tool.schema.parse(input.arguments));
      } else if (message.method === "ping") {
        result = {};
      } else {
        throw new Error("Unsupported request");
      }

      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Paws tool request rejected." },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("Tool bridge unavailable");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    tools,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
