import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createRemoteClient,
  pairRemote,
  RemoteAuthenticationError,
  remoteOrigin,
  subscribeRemote,
  type RemoteSocketFactory,
} from "./remote.ts";

const origin = "https://paws.example.test";
const session = `1893456000000.${"a".repeat(43)}`;
const connection = { origin, session };

afterEach(() => vi.useRealTimers());

it("rejects credentials, insecure addresses, paths, and query tokens", () => {
  for (const input of [
    "http://paws.test",
    "https://user:secret@paws.test",
    "https://paws.test/api",
    "https://paws.test?token=secret",
    "https://paws.test#token",
  ]) {
    expect(() => remoteOrigin(input)).toThrow();
  }

  expect(remoteOrigin(" https://PAWS.example.test:443/ ")).toBe(origin);
});

it("exchanges a token without putting it in a URL or using browser cookies", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ session }));
  expect(await pairRemote(origin, " private+token ", request)).toEqual(
    connection,
  );
  const [url, options] = request.mock.calls[0]!;
  expect(url).toBe(`${origin}/_companion/session`);
  expect(options).toMatchObject({
    method: "POST",
    headers: { Origin: origin },
    body: "token=private%2Btoken",
    credentials: "omit",
  });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it("does not accept a login page or save an invalid session", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("Incorrect", { status: 401 }));
  await expect(pairRemote(origin, "wrong", request)).rejects.toThrow(
    "Incorrect connection token",
  );
  request.mockResolvedValue(Response.json({ session: "invalid" }));
  await expect(pairRemote(origin, "token", request)).rejects.toThrow();
});

it("authenticates requests and validates snapshots at the boundary", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ agents: [] }));
  const client = createRemoteClient(connection, request);
  expect(await client.snapshot()).toEqual({ agents: [] });
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    headers: { Origin: origin, Authorization: `Bearer ${session}` },
    credentials: "omit",
  });
  request.mockResolvedValue(
    Response.json({ agents: [{ name: "incomplete" }] }),
  );
  await expect(client.snapshot()).rejects.toThrow();
  request.mockResolvedValue(new Response("Expired", { status: 401 }));
  await expect(client.snapshot()).rejects.toBeInstanceOf(
    RemoteAuthenticationError,
  );
  request.mockResolvedValue(
    Response.json({ error: "Only idle agents can move." }, { status: 409 }),
  );
  await expect(client.snapshot()).rejects.toThrow("Only idle agents can move.");
});

it("keeps a retry's request ID and model selection unchanged", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("Unavailable", { status: 502 }));
  const client = createRemoteClient(connection, request);
  const input = {
    requestId: "stable-id",
    text: "hello",
    selection: { providerId: "codex", modelId: "model", options: {} },
  };
  await expect(client.chat("agent/one", input)).rejects.toThrow("502");
  await expect(client.chat("agent/one", input)).rejects.toThrow("502");
  expect(request.mock.calls[0]?.[0]).toBe(
    `${origin}/api/agents/agent%2Fone/chat`,
  );
  expect(
    request.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
  ).toEqual([input, input]);
});

it("reconnects once and ignores late socket events after cleanup", () => {
  vi.useFakeTimers();
  const receive = vi.fn();
  const close = vi.fn();
  const events: { message(data: unknown): void; disconnected(): void }[] = [];
  const open: RemoteSocketFactory = vi.fn(
    (_url, _headers, message, disconnected) => {
      events.push({ message, disconnected });

      return { close };
    },
  );
  const stop = subscribeRemote(createRemoteClient(connection), open, receive);
  events[0]!.message(JSON.stringify({ agents: [] }));
  expect(receive).toHaveBeenLastCalledWith({ agents: [] }, null);
  events[0]!.message("malformed");
  expect(receive).toHaveBeenLastCalledWith(
    null,
    expect.stringContaining("invalid data"),
  );
  events[0]!.disconnected();
  events[0]!.disconnected();
  vi.advanceTimersByTime(2000);
  expect(open).toHaveBeenCalledTimes(2);
  receive.mockClear();
  events[0]!.message(JSON.stringify({ agents: [] }));
  expect(receive).not.toHaveBeenCalled();
  events[1]!.disconnected();
  stop();
  vi.advanceTimersByTime(10_000);
  events[1]!.message(JSON.stringify({ agents: [] }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});
