import { afterEach, expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/reactivity";
import {
  connectEnvironmentRosters,
  environmentRostersAtom,
} from "./environmentRosters.ts";

class MockSocket {
  static instances: MockSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  sendSnapshot(name: string) {
    this.onmessage?.({
      data: JSON.stringify({
        agents: [
          {
            id: "same-id",
            name,
            provider: "codex",
            status: "configured",
            createdAt: "2026-11-05",
          },
        ],
      }),
    });
  }
}

const peer = (id: string) => ({
  id,
  name: id,
  platform: "linux",
  url: `http://${id}:4312`,
});
const metadata = (ids = ["laptop", "server"]) => ({
  local: { id: "local-id", name: "Desktop", platform: "linux" },
  sharing: false,
  port: 4312,
  addresses: [],
  connections: [],
  discoveryError: null,
  linked: ids.map(peer),
});

function fixture(search = "") {
  const events = new EventTarget();
  vi.stubGlobal("window", {
    location: { href: `http://localhost:5173/${search}`, protocol: "http:" },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  vi.stubGlobal("WebSocket", MockSocket);
  const fetchMock = vi
    .fn()
    .mockImplementation(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetchMock);
  const registry = AtomRegistry.make();
  const dispose = connectEnvironmentRosters(registry);

  return { events, registry, dispose, fetchMock };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockSocket.instances = [];
});

it("subscribes to every other machine, keeps duplicate agent IDs separate, and reconnects independently", async () => {
  vi.useFakeTimers();
  const { registry, dispose } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances.map((socket) => socket.url)).toEqual([
    "ws://localhost:5173/api/environments/laptop/proxy/ws",
    "ws://localhost:5173/api/environments/server/proxy/ws",
  ]);
  const [laptop, server] = MockSocket.instances;
  laptop!.sendSnapshot("Laptop Ada");
  server!.sendSnapshot("Server Ada");
  const read = () => registry.get(environmentRostersAtom).rosters;
  expect(read().map((source) => source.snapshot.agents[0]?.name)).toEqual([
    undefined,
    "Laptop Ada",
    "Server Ada",
  ]);
  laptop!.close();
  expect(read()[1]?.connected).toBe(false);
  expect(read()[1]?.snapshot.agents[0]?.name).toBe("Laptop Ada");
  expect(read()[2]?.connected).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(MockSocket.instances).toHaveLength(3);
  dispose();
  MockSocket.instances[2]!.sendSnapshot("Late update");
  await vi.advanceTimersByTimeAsync(4000);
  expect(MockSocket.instances).toHaveLength(3);
  expect(registry.get(environmentRostersAtom).rosters).toEqual([]);
  registry.dispose();
});

it("includes the local machine while viewing a remote agent, removes forgotten connections, and ignores late refreshes", async () => {
  vi.useFakeTimers();
  const { events, registry, dispose, fetchMock } = fixture(
    "?environment=laptop",
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances.map((socket) => socket.url)).toEqual([
    "ws://localhost:5173/ws",
    "ws://localhost:5173/api/environments/server/proxy/ws",
  ]);
  fetchMock.mockImplementation(async () => Response.json(metadata(["laptop"])));
  events.dispatchEvent(new Event("paws-environments-changed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances[1]?.closed).toBe(true);
  expect(
    registry.get(environmentRostersAtom).rosters.map((item) => item.id),
  ).toEqual([null, "laptop"]);
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  events.dispatchEvent(new Event("focus"));
  dispose();
  resolve(Response.json(metadata()));
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances).toHaveLength(2);
  expect(registry.get(environmentRostersAtom).rosters).toEqual([]);
  registry.dispose();
});

it("subscribes only to enabled environments and resumes them when re-enabled", async () => {
  vi.useFakeTimers();
  const { events, registry, dispose, fetchMock } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  MockSocket.instances[1]!.sendSnapshot("Server Ada");
  fetchMock.mockImplementation(async () =>
    Response.json({
      ...metadata(),
      linked: [{ ...peer("server"), enabled: false }],
    }),
  );
  events.dispatchEvent(new Event("paws-environments-changed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances.every((socket) => socket.closed)).toBe(true);
  expect(
    registry.get(environmentRostersAtom).rosters.map((item) => item.id),
  ).toEqual([null]);
  fetchMock.mockImplementation(async () =>
    Response.json({
      ...metadata(),
      linked: [{ ...peer("server"), enabled: true }],
    }),
  );
  events.dispatchEvent(new Event("paws-environments-changed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(MockSocket.instances).toHaveLength(3);
  MockSocket.instances[2]!.sendSnapshot("Resumed Ada");
  expect(
    registry.get(environmentRostersAtom).rosters[1]?.snapshot.agents[0]?.name,
  ).toBe("Resumed Ada");
  dispose();
  registry.dispose();
});
