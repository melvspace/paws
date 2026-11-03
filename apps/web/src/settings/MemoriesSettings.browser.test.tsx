import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { AgentSettingsPanel } from "./AgentSettingsPanel.tsx";
import { MemoriesSettings } from "./MemoriesSettings.tsx";

const agent = {
  id: "ada",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-11-01",
} as const;
const entry = {
  id: "fact",
  text: "Use direct message links",
  createdAt: "2026-11-03",
  updatedAt: "2026-11-03",
};

it("opens a read-only memory list beside Routines and confirms deletion", async () => {
  const requests = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (_url, init) =>
      Response.json(init?.method === "POST" ? [] : [entry]),
    );

  try {
    await using _screen = await render(
      <AgentSettingsPanel
        agent={agent}
        connected
        beforeClose={{ current: null }}
        onDismiss={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Routines", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Memories", exact: true }).click();
    await expect
      .element(page.getByText(entry.text, { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Search when needed", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "New memory", exact: true }))
      .not.toBeInTheDocument();
    await page
      .getByRole("button", {
        name: `Delete memory: ${entry.text}`,
        exact: true,
      })
      .click();
    expect(
      requests.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .element(page.getByText(entry.text, { exact: true }))
      .toBeVisible();
    await page
      .getByRole("button", {
        name: `Delete memory: ${entry.text}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete memory", exact: true })
      .click();
    await expect
      .element(page.getByText("No memories yet", { exact: true }))
      .toBeVisible();
    expect(requests).toHaveBeenLastCalledWith(
      "/api/agents/ada/memories",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "delete",
          id: "fact",
          expected: entry.text,
        }),
      }),
    );
    await page
      .getByRole("button", { name: "Back to agent settings", exact: true })
      .click();
    await expect
      .element(page.getByRole("button", { name: "Memories", exact: true }))
      .toBeVisible();
  } finally {
    requests.mockRestore();
  }
});

it("waits for pending deletions before closing", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const requests = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (_url, init) =>
      init?.method === "POST" ? pending : Response.json([entry]),
    );
  const beforeClose: { current: (() => Promise<void>) | null } = {
    current: null,
  };

  try {
    await using _screen = await render(
      <MemoriesSettings
        kind="agents"
        ownerId="ada"
        connected
        beforeClose={beforeClose}
      />,
    );
    await page
      .getByRole("button", {
        name: `Delete memory: ${entry.text}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete memory", exact: true })
      .click();
    let closed = false;
    const closing = beforeClose.current!().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    finish(Response.json([]));
    await closing;
    expect(closed).toBe(true);
  } finally {
    finish(Response.json([]));
    requests.mockRestore();
  }
});
