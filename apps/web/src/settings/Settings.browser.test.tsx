import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";
import { AgentDialog } from "../AgentDialog.tsx";
import { Button } from "../components/ui/button.tsx";
import type { Agent } from "@paws/contracts";

const agent: Agent = {
  id: "ada",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-10-31T00:00:00.000Z",
};

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
