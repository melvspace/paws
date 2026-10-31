import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { AgentDialog } from "./AgentDialog.tsx";
import { defaultAgentAvatar } from "@paws/contracts";

const agent = {
  id: "avatar-agent",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-01-01",
  avatar: { animal: "cat", color: "blue" },
} as const;

it("creates an agent with the selected animal and color", async () => {
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (_url, options) =>
      Response.json({ ...agent, ...JSON.parse(String(options?.body)) }),
    );
  const dismiss = vi.fn();
  const previousHash = location.hash;

  try {
    await using _screen = await render(
      <AgentDialog agent={null} connected onDismiss={dismiss} />,
    );
    await page.getByRole("textbox", { name: "Name" }).fill("Ada");
    await page.getByRole("button", { name: "mouse", exact: true }).click();
    await page.getByRole("button", { name: "red", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "mouse", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Ada",
          avatar: { animal: "mouse", color: "red" },
        }),
      }),
    );
  } finally {
    fetchMock.mockRestore();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}${previousHash}`,
    );
  }
});

it("autosaves avatar selections, retains failed changes, and retries on dismissal", async () => {
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  const dismiss = vi.fn();

  try {
    await using _screen = await render(
      <AgentDialog agent={agent} connected onDismiss={dismiss} />,
    );
    await page.getByRole("button", { name: "rabbit", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "pink", exact: true }))
      .toBeEnabled();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/agents/avatar-agent",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Ada",
          avatar: { animal: "rabbit", color: "blue" },
        }),
      }),
    );
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await page.getByRole("button", { name: "pink", exact: true }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "pink", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(dismiss).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/agents/avatar-agent",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Ada",
          avatar: { animal: "rabbit", color: "pink" },
        }),
      }),
    );
  } finally {
    fetchMock.mockRestore();
  }
});

it("gives legacy agents a stable avatar and keeps choices disabled while disconnected", async () => {
  const { avatar: _avatar, ...legacy } = agent;
  const expected = defaultAgentAvatar(legacy.id);
  await using _screen = await render(
    <AgentDialog agent={legacy} connected={false} onDismiss={() => {}} />,
  );
  const animal = page.getByRole("button", {
    name: expected.animal,
    exact: true,
  });
  const color = page.getByRole("button", { name: expected.color, exact: true });
  await expect.element(animal).toHaveAttribute("aria-pressed", "true");
  await expect.element(color).toHaveAttribute("aria-pressed", "true");
  await expect.element(animal).toBeDisabled();
  await expect.element(color).toBeDisabled();
});
