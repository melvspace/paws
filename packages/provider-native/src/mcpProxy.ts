// Trusted stdio transport for ACP agents without HTTP MCP support.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const response = await fetch(process.env.PAWS_TOOL_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PAWS_TOOL_TOKEN}`,
      },
      body: line,
    });
    const body = await response.text();

    if (body) process.stdout.write(`${body}\n`);
  } catch {
    process.exitCode = 1;
    break;
  }
}
