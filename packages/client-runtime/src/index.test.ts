import { afterEach, expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/reactivity";
import { agentsAtom, connectAgents } from "./index.ts";

class MockSocket {
  static instances: MockSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    MockSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  MockSocket.instances = [];
});

it("publishes validated snapshots to Effect atoms and reconnects without leaking disposed events", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockSocket);
  const registry = AtomRegistry.make();
  const dispose = connectAgents(registry, "ws://localhost/ws");
  const socket = MockSocket.instances[0]!;
  socket.onmessage?.({ data: '{"agents":[]}' });
  expect(registry.get(agentsAtom).connected).toBe(true);
  socket.onmessage?.({ data: '{"agents":[{}]}' });
  expect(registry.get(agentsAtom).error).toBe(
    "The server sent an invalid agent list.",
  );
  expect(registry.get(agentsAtom).snapshot).toEqual({ agents: [] });
  socket.close();
  expect(registry.get(agentsAtom).connected).toBe(false);
  vi.advanceTimersByTime(2000);
  expect(MockSocket.instances).toHaveLength(2);
  dispose();
  MockSocket.instances[1]!.onmessage?.({ data: '{"agents":[]}' });
  expect(registry.get(agentsAtom).connected).toBe(false);
  vi.advanceTimersByTime(4000);
  expect(MockSocket.instances).toHaveLength(2);
  registry.dispose();
});
