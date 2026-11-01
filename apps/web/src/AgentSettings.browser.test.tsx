import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { agentsAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { render } from "../test/render.tsx";
import { AgentDialog } from "./AgentDialog.tsx";

it("autosaves membership immediately and memories on blur without an explicit save button", async () => {
  const agent = {
    id: "ada",
    name: "Ada",
    provider: "codex",
    status: "configured",
    createdAt: "2026-11-01",
  } as const;
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [agent],
      teams: [
        {
          id: "project",
          name: "Introvert",
          memory: "",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));

  try {
    await using _screen = await render(
      <AgentDialog agent={agent} connected onDismiss={() => {}} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .not.toBeInTheDocument();
    const checkbox = page.getByRole("checkbox", {
      name: "Introvert",
      exact: true,
    });
    const control = checkbox.element();
    expect(control.getBoundingClientRect().width).toBe(16);
    expect(
      control.closest("label")!.getBoundingClientRect().height,
    ).toBeLessThan(32);
    const name = page
      .getByRole("textbox", { name: "Name", exact: true })
      .element();
    const memory = page
      .getByRole("textbox", { name: "Personal memories", exact: true })
      .element();
    expect(name.closest(".settings-group")).toBe(
      memory.closest(".settings-group"),
    );
    expect(
      page
        .getByRole("heading", { name: "Agent settings", exact: true })
        .element()
        .classList.contains("sr-only"),
    ).toBe(true);
    expect(document.body.textContent).not.toContain(
      "Changes save automatically",
    );
    expect(document.body.textContent).not.toContain(
      "Share skills, files, and memories with teammates.",
    );
    await checkbox.click();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ teamIds: ["project"] });
    await page
      .getByRole("textbox", { name: "Personal memories", exact: true })
      .fill("Prefer concise answers");
    await page.getByRole("textbox", { name: "Name", exact: true }).click();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ memory: "Prefer concise answers" });
  } finally {
    fetchMock.mockRestore();
    appAtomRegistry.set(agentsAtom, {
      snapshot: { agents: [] },
      connected: false,
      error: null,
    });
  }
});

it("flushes edits made during an autosave before dismissing the dialog", async () => {
  const agent = {
    id: "ada",
    name: "Ada",
    provider: "codex",
    status: "configured",
    createdAt: "2026-11-01",
  } as const;
  let finish = (_response: Response) => {};
  const first = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockReturnValueOnce(first)
    .mockResolvedValue(new Response(null, { status: 204 }));
  const dismiss = vi.fn();

  try {
    await using _screen = await render(
      <AgentDialog agent={agent} connected onDismiss={dismiss} />,
    );
    const memory = page.getByRole("textbox", {
      name: "Personal memories",
      exact: true,
    });
    await memory.fill("First memory");
    await page.getByRole("textbox", { name: "Name", exact: true }).click();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    await memory.fill("Latest memory");
    await page.getByRole("button", { name: "Close dialog" }).click();
    expect(dismiss).not.toHaveBeenCalled();
    finish(new Response(null, { status: 204 }));
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ memory: "Latest memory" });
  } finally {
    finish(new Response(null, { status: 204 }));
    fetchMock.mockRestore();
  }
});
