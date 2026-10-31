import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";
import { AgentDialog } from "../AgentDialog.tsx";
import { Button } from "../components/ui/button.tsx";
import type { Agent } from "@paws/contracts";
import {
  followUpStorageKey,
  messageDisplayStorageKey,
} from "./chatPreferences.ts";

const agent: Agent = {
  id: "ada",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-10-31T00:00:00.000Z",
};

it("stores the follow-up default in Settings Chat and keeps it after reopening", async () => {
  localStorage.removeItem(followUpStorageKey);

  try {
    {
      await using _screen = await render(
        <AppSettingsDialog onDismiss={() => {}} />,
      );
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Follow-ups" }))
        .toBeVisible();
      await page
        .getByRole("button", { name: "Follow-up behavior", exact: true })
        .click();
      await page
        .getByRole("menuitemradio", { name: "Queue for next turn" })
        .click();
      expect(localStorage.getItem(followUpStorageKey)).toBe("queue");
    }

    await using _screen = await render(
      <AppSettingsDialog initialPage="Chat" onDismiss={() => {}} />,
    );
    await expect
      .element(
        page.getByRole("button", { name: "Follow-up behavior", exact: true }),
      )
      .toHaveTextContent("Queue");
  } finally {
    localStorage.removeItem(followUpStorageKey);
  }
});

function Settings({ agentSettings = false }: { agentSettings?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open settings</Button>
      {open &&
        (agentSettings ? (
          <AgentDialog
            agent={agent}
            connected
            onDismiss={() => setOpen(false)}
          />
        ) : (
          <AppSettingsDialog onDismiss={() => setOpen(false)} />
        ))}
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("paws.theme");
  delete document.documentElement.dataset.theme;
});

it("changes theme, closes with Escape, and restores the settings trigger", async () => {
  await using _screen = await render(<Settings />);
  const trigger = page.getByRole("button", { name: "Open settings" });
  await trigger.click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("paws.theme")).toBe("dark");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("saves on dismissal and keeps failed edits open", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Settings agentSettings />);
  await page.getByRole("button", { name: "Open settings" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await expect.element(name).toHaveFocus();
  await name.fill("Ada Lovelace");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Could not save agent settings. Check your connection and name.",
    );
  await expect
    .element(page.getByRole("dialog", { name: "Agent settings" }))
    .toBeVisible();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/agents/ada",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Ada Lovelace" }),
    }),
  );
});

it("confirms deletion in an alert dialog and defaults focus to Cancel", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Settings agentSettings />);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect
    .element(page.getByRole("alertdialog", { name: "Delete Ada?" }))
    .toBeVisible();
  const backdrops = document.querySelectorAll<HTMLElement>(
    ".ui-dialog-backdrop:not([hidden])",
  );
  expect(backdrops).toHaveLength(2);
  expect(getComputedStyle(backdrops[1]!).backdropFilter).toBe("blur(6px)");

  await expect
    .element(page.getByRole("button", { name: "Cancel", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Delete agent", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/agents/ada", {
    method: "DELETE",
  });
});

it("defaults to whole messages and remembers streaming after reopening settings", async () => {
  localStorage.removeItem(messageDisplayStorageKey);

  try {
    {
      await using _screen = await render(
        <AppSettingsDialog initialPage="Chat" onDismiss={() => {}} />,
      );
      const picker = page.getByRole("button", {
        name: "Agent message display",
        exact: true,
      });
      await expect.element(picker).toHaveTextContent("Whole messages");
      await picker.click();
      await page
        .getByRole("menuitemradio", { name: "Streaming", exact: true })
        .click();
      expect(localStorage.getItem(messageDisplayStorageKey)).toBe("streaming");
    }

    await using _screen = await render(
      <AppSettingsDialog initialPage="Chat" onDismiss={() => {}} />,
    );
    await expect
      .element(
        page.getByRole("button", {
          name: "Agent message display",
          exact: true,
        }),
      )
      .toHaveTextContent("Streaming");
  } finally {
    localStorage.removeItem(messageDisplayStorageKey);
  }
});
