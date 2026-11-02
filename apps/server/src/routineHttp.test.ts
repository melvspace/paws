import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { createServer } from "./main.ts";

it("keeps management endpoints off the dedicated webhook listener", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routine-http-");
  const app = createServer(root);
  app.webhookServer.listen(0, "127.0.0.1");
  await once(app.webhookServer, "listening");
  const address = app.webhookServer.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  try {
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/agents`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/routine-preview`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${base}/hooks/routines/00000000-0000-4000-8000-000000000001`,
          { method: "POST", body: "{}" },
        )
      ).status,
    ).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
