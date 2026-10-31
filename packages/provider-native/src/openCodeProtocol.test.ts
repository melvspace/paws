import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { probeOpenCodeProtocol } from "./openCodeProtocol.ts";

async function fixture() {
  let responses: Record<
    string,
    { status?: number; type?: string; body: unknown }
  > = {};
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const value = responses[request.url ?? ""] ?? { status: 404, body: "" };
    response
      .writeHead(value.status ?? 200, {
        "Content-Type": value.type ?? "application/json",
      })
      .end(
        typeof value.body === "string"
          ? value.body
          : JSON.stringify(value.body),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("Missing listener");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respond(value: typeof responses) {
      responses = value;
      requests.length = 0;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("selects the running protocol across upgrades without pinning a patch release or caching an old result", async () => {
  await using server = await fixture();
  // Simulated wire contracts, not declarations about the locally installed executable.
  for (const version of [
    "1.18.0",
    "1.99.42",
    "2.0.0-beta.1",
    "2.99.42",
    "3.0.0",
  ]) {
    const generation = version.startsWith("1.") ? "v1" : "v2";
    server.respond(
      generation === "v1"
        ? {
            "/api/info": { type: "text/html", body: "<html>fallback</html>" },
            "/global/health": { body: { healthy: true, version } },
          }
        : { "/api/info": { body: { pid: 123, version } } },
    );
    expect(
      await probeOpenCodeProtocol(server.url, {}, AbortSignal.timeout(1000)),
    ).toEqual({ generation, version });
    expect(server.requests).toEqual(
      generation === "v1"
        ? ["GET /api/info", "GET /global/health"]
        : ["GET /api/info"],
    );
  }
});

it("does not mistake HTML, unrelated JSON, malformed JSON or unknown versions for a working protocol", async () => {
  await using server = await fixture();

  for (const body of [
    { version: "2.0.0" },
    { version: "unknown", pid: 1 },
    { version: "0.0.0", pid: 1 },
    "{malformed",
  ]) {
    server.respond({
      "/api/info": { body },
      "/global/health": { type: "text/html", body: "fallback" },
    });
    await expect(
      probeOpenCodeProtocol(server.url, {}, AbortSignal.timeout(1000)),
    ).rejects.toThrow("recognized OpenCode protocol");
  }
});

it("stops on authentication rejection without retrying another protocol or exposing response bodies", async () => {
  await using server = await fixture();
  server.respond({
    "/api/info": { status: 401, body: { secret: "must-not-leak" } },
  });
  await expect(
    probeOpenCodeProtocol(server.url, {}, AbortSignal.timeout(1000)),
  ).rejects.toThrow("rejected its connection credentials");
  expect(server.requests).toEqual(["GET /api/info"]);
});

it("honors cancellation without submitting a session or prompt", async () => {
  await using server = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("Cancelled test"));
  await expect(
    probeOpenCodeProtocol(server.url, {}, controller.signal),
  ).rejects.toThrow("Cancelled test");
  expect(server.requests).toEqual([]);
});
