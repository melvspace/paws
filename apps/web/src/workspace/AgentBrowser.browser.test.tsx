import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { BrowserServerMessage } from "@paws/contracts";
import { render } from "../../test/render.tsx";
import { AgentWorkspace } from "./AgentWorkspace.tsx";

const bridge = vi.hoisted(() => ({
  receive: (_message: BrowserServerMessage) => {},
  close: vi.fn(),
}));
vi.mock("@paws/client-runtime", async (original) => ({
  ...(await original<typeof import("@paws/client-runtime")>()),
  connectBrowser: (
    _agentId: string,
    receive: typeof bridge.receive,
    _connection: (connected: boolean) => void,
    observe: boolean,
  ) => {
    if (observe) bridge.receive = receive;

    return { send: () => true, close: bridge.close };
  },
}));

it.each([false, true])(
  "reveals agent-opened browsers with sidebar open=%s and respects dismissal",
  async (sidebarOpen) => {
    const agent = {
      id: "browser-reveal-test",
      name: "Ada",
      provider: "codex",
      status: "configured",
      createdAt: "2026-01-01",
    } as const;
    localStorage.setItem(
      `paws.workspace.${agent.id}`,
      JSON.stringify({ sidebarOpen }),
    );
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      Response.json({
        agentId: agent.id,
        revision: 1,
        status: "idle",
        error: null,
        selection: null,
        messages: [],
      }),
    );
    const state = {
      type: "state",
      tabs: [
        {
          id: "agent-tab",
          url: "https://example.test/",
          title: "Example",
          loading: false,
          owner: "agent",
          generation: 0,
          dialog: null,
        },
      ],
      selectedTabId: null,
      controllerTabId: null,
      width: 1280,
      height: 800,
    } as const;

    try {
      await using _screen = await render(
        <AgentWorkspace
          agent={agent}
          onSettings={() => {}}
          onProviderSettings={() => {}}
        />,
      );
      bridge.receive(state);
      await expect
        .element(page.getByRole("region", { name: "Browser", exact: true }))
        .toBeVisible();

      if (sidebarOpen) {
        await expect
          .element(page.getByRole("tab", { name: "Browser", exact: true }))
          .toHaveAttribute("aria-selected", "true");
        await page
          .getByRole("button", { name: "Close Browser tab", exact: true })
          .click();
      } else {
        await expect
          .element(
            page.getByRole("region", { name: "Floating browser", exact: true }),
          )
          .toBeVisible();
        document
          .querySelector<HTMLElement>(".floating-browser-titlebar")!
          .focus();
        await page
          .getByRole("button", { name: "Close floating browser" })
          .click();
      }

      bridge.receive(state);
      await expect
        .element(page.getByRole("textbox", { name: "Browser address" }))
        .not.toBeInTheDocument();
      bridge.receive({ ...state, tabs: [{ ...state.tabs[0], id: "new-tab" }] });
      await expect
        .element(page.getByRole("region", { name: "Browser", exact: true }))
        .toBeVisible();
      bridge.receive({ ...state, tabs: [] });
      await expect
        .element(page.getByRole("textbox", { name: "Browser address" }))
        .not.toBeInTheDocument();
    } finally {
      fetchMock.mockRestore();
    }
  },
);
