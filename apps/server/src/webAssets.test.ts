import { expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { webAssets } from "./webAssets.ts";

it("serves production assets and SPA routes without exposing API routes or parent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-assets-"));
  const directory = join(root, "web");
  await mkdir(directory);
  await writeFile(join(directory, "index.html"), "<html>Paws</html>");
  await writeFile(join(root, "private.txt"), "secret");
  const server = createServer(async (request, response) => {
    if (!(await webAssets(request, response, directory)))
      response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("No port");

  const url = `http://127.0.0.1:${address.port}`;

  try {
    expect(await (await fetch(`${url}/chat/agent`)).text()).toBe(
      "<html>Paws</html>",
    );
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${url}/api/agents`)).status).toBe(404);
    expect((await fetch(`${url}/%2e%2e%2fprivate.txt`)).status).toBe(403);
    expect(await (await fetch(url, { method: "HEAD" })).text()).toBe("");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
