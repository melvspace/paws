import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { makeEnvironmentDiscovery } from "./environmentDiscovery.ts";

const { socket } = vi.hoisted(() => ({
  socket: { current: undefined as FakeSocket | undefined },
}));

class FakeSocket extends EventEmitter {
  send = vi.fn(
    (
      _data: string | Buffer,
      _port: number,
      _address: string,
      done: (error: Error | null) => void,
    ) => done(null),
  );
  close = vi.fn();
  addMembership = vi.fn();
  setMulticastInterface = vi.fn();
  setMulticastTTL = vi.fn();
  setMulticastLoopback = vi.fn();
  bind(_port: number, _host: string, ready: () => void) {
    ready();
  }
}

vi.mock("node:dgram", () => ({
  createSocket: () => {
    const next = new FakeSocket();
    socket.current = next;
    return next;
  },
}));
vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    lan: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
    secondLan: [{ address: "192.168.2.5", family: "IPv4", internal: false }],
  }),
}));

const identity = { id: "local", name: "Local", platform: "linux" };
const peer = { id: "remote", name: "Remote", platform: "linux" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("advertises only while sharing, uses sender addresses, ignores invalid packets and expires peers", async () => {
  vi.useFakeTimers();
  let shared: number | undefined;
  const discovery = makeEnvironmentDiscovery(
    () => identity,
    () => shared,
    async () => ({ BackendState: "Running" }),
  );
  discovery.start();
  const lan = socket.current!;
  const sender = { address: "192.168.1.10", port: 4313 };
  lan.emit("message", Buffer.from("paws-environment-query-v1"), sender);
  expect(lan.send).not.toHaveBeenCalled();
  shared = 4312;
  lan.emit("message", Buffer.from("paws-environment-query-v1"), sender);
  expect(JSON.parse(lan.send.mock.calls[0]![0].toString())).toMatchObject({
    identity,
    port: 4312,
  });
  expect(lan.send.mock.calls[0]!.slice(1, 3)).toEqual([4313, sender.address]);
  const advertise = (data: unknown) =>
    lan.emit("message", Buffer.from(JSON.stringify(data)), sender);
  advertise({
    protocol: "paws-environment-v1",
    identity: peer,
    port: 4312,
    url: "http://attacker",
  });
  advertise({
    protocol: "paws-environment-v1",
    identity: { ...peer, id: "invalid" },
    port: -1,
  });
  advertise({ protocol: "paws-environment-v1", identity, port: 4312 });
  advertise("invalid");
  const finding = discovery.discover();
  await vi.advanceTimersByTimeAsync(800);
  expect((await finding).environments).toEqual([
    { ...peer, source: "lan", url: "http://192.168.1.10:4312" },
  ]);
  await vi.advanceTimersByTimeAsync(30_001);
  const stale = discovery.discover();
  await vi.advanceTimersByTimeAsync(800);
  expect((await stale).environments).toEqual([]);
  discovery.close();
  expect(lan.close).toHaveBeenCalledOnce();
});

it("probes online Tailscale peers, skips unrelated servers and reports discovery failures", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.includes("100.64.0.1")
        ? Response.json(peer)
        : Response.json({}, { status: 404 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const discovery = makeEnvironmentDiscovery(
    () => identity,
    () => undefined,
    async () => ({
      BackendState: "Running",
      Peer: {
        a: { Online: true, TailscaleIPs: ["100.64.0.1", "100.64.0.2"] },
        b: { Online: false, TailscaleIPs: ["100.64.0.3"] },
      },
    }),
  );
  const finding = discovery.discover();
  await vi.advanceTimersByTimeAsync(800);
  expect((await finding).environments).toEqual([
    { ...peer, source: "tailscale", url: "http://100.64.0.1:4312" },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  discovery.close();
  const unavailable = makeEnvironmentDiscovery(
    () => identity,
    () => undefined,
    async () => {
      throw new Error("missing CLI");
    },
  );
  unavailable.start();
  socket.current!.emit("error", new Error("blocked multicast"));
  const failed = unavailable.discover();
  await vi.advanceTimersByTimeAsync(800);
  expect((await failed).warnings).toHaveLength(2);
  unavailable.close();
});

it("queries every eligible LAN interface", async () => {
  vi.useFakeTimers();
  const discovery = makeEnvironmentDiscovery(
    () => identity,
    () => undefined,
    async () => ({ BackendState: "Running" }),
  );
  discovery.start();
  const lan = socket.current!;
  const finding = discovery.discover();
  await vi.advanceTimersByTimeAsync(800);
  await finding;
  expect(lan.setMulticastInterface.mock.calls).toEqual([
    ["192.168.1.5"],
    ["192.168.2.5"],
  ]);
  expect(lan.send.mock.calls.map((call) => call.slice(0, 3))).toEqual([
    ["paws-environment-query-v1", 4313, "239.255.43.10"],
    ["paws-environment-query-v1", 4313, "239.255.43.10"],
  ]);
  expect(lan.setMulticastInterface.mock.invocationCallOrder[1]).toBeGreaterThan(
    lan.send.mock.invocationCallOrder[0]!,
  );
  discovery.close();
});

it("continues an incomplete Tailscale scan on the next discovery", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (url === "http://100.64.0.64:4312/identity") return Response.json(peer);

    throw new Error("Peer does not run Paws");
  });
  vi.stubGlobal("fetch", fetchMock);
  const discovery = makeEnvironmentDiscovery(
    () => identity,
    () => undefined,
    async () => ({
      BackendState: "Running",
      Peer: {
        peers: {
          Online: true,
          TailscaleIPs: Array.from(
            { length: 64 },
            (_, index) => `100.64.0.${index + 1}`,
          ),
        },
      },
    }),
  );
  const first = discovery.discover();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await first).warnings).toContain(
    "Tailscale discovery is incomplete. Discover again to scan the remaining peers.",
  );
  expect(fetchMock).not.toHaveBeenCalledWith(
    "http://100.64.0.64:4312/identity",
    expect.anything(),
  );
  const second = discovery.discover();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await second).environments).toContainEqual({
    ...peer,
    source: "tailscale",
    url: "http://100.64.0.64:4312",
  });
  discovery.close();
});
