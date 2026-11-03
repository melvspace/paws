import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import type {
  BrowserServerMessage,
  BrowserState,
  BrowserClientMessage,
} from "@paws/contracts";
import { BrowserPanel } from "./BrowserPanel.tsx";

const bridge = vi.hoisted(() => ({
  send: vi.fn((_message: BrowserClientMessage) => true),
  close: vi.fn(),
  receive: (_message: BrowserServerMessage) => {},
  connected: (_connected: boolean) => {},
}));
vi.mock("@paws/client-runtime", () => ({
  connectBrowser: (
    _id: string,
    receive: typeof bridge.receive,
    connected: typeof bridge.connected,
  ) => {
    bridge.receive = receive;
    bridge.connected = connected;

    return { send: bridge.send, close: bridge.close };
  },
}));

const state: BrowserState = {
  type: "state",
  tabs: [
    {
      id: "tab",
      url: "https://example.test",
      title: "Example",
      loading: false,
      owner: "agent",
      generation: 0,
      dialog: null,
    },
  ],
  selectedTabId: "tab",
  controllerTabId: null,
  width: 1280,
  height: 800,
};

it("shows the live page, requires takeover for input, and sends the current lease", async () => {
  bridge.send.mockClear();
  bridge.close.mockClear();
  await using screen = await render(
    <div style={{ width: 800, height: 600 }}>
      <BrowserPanel agentId="agent" active />
    </div>,
  );
  bridge.receive(state);
  bridge.receive({
    type: "frame",
    tabId: "tab",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  });
  await expect
    .element(page.getByRole("button", { name: "Take control", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Browser address" }))
    .toBeDisabled();
  const image = page.getByRole("img", { name: "Browser page interaction" });
  await image.click();
  expect(
    bridge.send.mock.calls.some(([message]) => message.type === "pointer"),
  ).toBe(false);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "takeControl",
    tabId: "tab",
  });
  bridge.receive({
    ...state,
    controllerTabId: "tab",
    tabs: [{ ...state.tabs[0]!, owner: "human", generation: 7 }],
  });
  await expect
    .element(page.getByRole("button", { name: "Return control" }))
    .toBeVisible();
  await image.click();
  await userEvent.keyboard("A");
  expect(bridge.send.mock.calls).toEqual(
    expect.arrayContaining([
      [
        expect.objectContaining({
          type: "pointer",
          phase: "down",
          tabId: "tab",
          generation: 7,
        }),
      ],
      [
        expect.objectContaining({
          type: "pointer",
          phase: "up",
          tabId: "tab",
          generation: 7,
        }),
      ],
      [
        expect.objectContaining({
          type: "key",
          key: "A",
          phase: "down",
          generation: 7,
        }),
      ],
    ]),
  );
  await page
    .getByRole("textbox", { name: "Browser address" })
    .fill("example.test/next");
  await userEvent.keyboard("{Enter}");
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "action",
    generation: 7,
    input: {
      action: "navigate",
      tabId: "tab",
      url: "https://example.test/next",
    },
  });
  await page.getByRole("button", { name: "Return control" }).click();
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "releaseControl",
    tabId: "tab",
  });
  bridge.receive({ type: "error", message: "Navigation failed. Retry." });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Navigation failed. Retry.");
  bridge.connected(false);
  await expect
    .element(page.getByRole("button", { name: "Reconnect" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Reconnect" }).click();
  expect(bridge.close).toHaveBeenCalledTimes(1);
  await screen[Symbol.asyncDispose]();
});

it("keeps takeover when the panel is hidden and clears pressed input on window blur", async () => {
  bridge.send.mockClear();
  await using screen = await render(
    <div style={{ width: 800, height: 600 }}>
      <BrowserPanel agentId="agent" active={false} />
    </div>,
  );
  bridge.receive({
    ...state,
    controllerTabId: "tab",
    tabs: [{ ...state.tabs[0]!, owner: "human", generation: 3 }],
  });
  await vi.waitFor(() =>
    expect(bridge.send).toHaveBeenCalledWith({ type: "watch", tabId: null }),
  );
  expect(
    bridge.send.mock.calls.some(([input]) => input.type === "releaseControl"),
  ).toBe(false);
  window.dispatchEvent(new Event("blur"));
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "resetInput",
    tabId: "tab",
    generation: 3,
  });
  await screen[Symbol.asyncDispose]();
});

it("opens a tab from the empty browser and keeps the toolbar compact and flat", async () => {
  bridge.send.mockClear();
  await using _screen = await render(
    <div style={{ width: 800, height: 600 }}>
      <BrowserPanel agentId="agent" active />
    </div>,
  );
  bridge.receive({ ...state, tabs: [], selectedTabId: null });
  await page.getByRole("button", { name: "New browser tab" }).click();
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "action",
    generation: 0,
    input: { action: "open" },
  });
  const toolbar = document.querySelector<HTMLElement>(".browser-toolbar")!;
  const style = getComputedStyle(toolbar);
  expect(style.borderRadius).toBe("0px");
  expect(style.marginBottom).toBe("0px");
  expect(style.maxWidth).toBe("none");
});

it("waits for browser startup before enabling new tabs or showing an empty browser", async () => {
  bridge.send.mockClear();
  await using _screen = await render(
    <div style={{ width: 800, height: 600 }}>
      <BrowserPanel agentId="agent" active />
    </div>,
  );
  bridge.connected(true);
  await userEvent.tab();
  await expect
    .element(page.getByRole("button", { name: "New browser tab" }))
    .toBeDisabled();
  await expect.element(page.getByText("Connecting to browser…")).toBeVisible();
  await expect
    .element(page.getByText("Open a tab or ask your agent to browse."))
    .not.toBeInTheDocument();
  bridge.receive({ type: "status", message: "Preparing browser…" });
  await expect.element(page.getByText("Preparing browser…")).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  bridge.receive({ ...state, tabs: [], selectedTabId: null });
  await expect
    .element(page.getByRole("button", { name: "New browser tab" }))
    .toBeEnabled();
});

it("forwards hover movement and releases input when a drag ends outside the image", async () => {
  bridge.send.mockClear();
  await using _screen = await render(
    <div style={{ width: 800, height: 600 }}>
      <BrowserPanel agentId="agent" active />
    </div>,
  );
  bridge.receive({
    ...state,
    controllerTabId: "tab",
    tabs: [{ ...state.tabs[0]!, owner: "human", generation: 7 }],
  });
  bridge.receive({
    type: "frame",
    tabId: "tab",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  });
  await expect.element(page.getByRole("img")).toBeVisible();
  const image = document.querySelector<HTMLImageElement>(".browser-stage img")!;
  const rect = image.getBoundingClientRect();
  image.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      buttons: 0,
    }),
  );
  expect(bridge.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "pointer",
      phase: "move",
      tabId: "tab",
      generation: 7,
    }),
  );
  image.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      clientX: rect.right + 50,
      clientY: rect.bottom + 50,
      button: 0,
    }),
  );
  expect(bridge.send).toHaveBeenLastCalledWith({
    type: "resetInput",
    tabId: "tab",
    generation: 7,
  });
});
