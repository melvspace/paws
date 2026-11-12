import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { agentsAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { render } from "../test/render.tsx";
import { AgentDialog } from "./AgentDialog.tsx";
import { AvatarPicker } from "./AvatarPicker.tsx";
import "./settings/agent-settings.css";

it("places an unclipped Edit control below the avatar", async () => {
  const change = vi.fn();
  await using _screen = await render(
    <div className="agent-settings-content">
      <AvatarPicker
        compact
        value={{ animal: "raccoon", color: "red" }}
        disabled={false}
        onChange={change}
      />
    </div>,
  );
  const edit = page.getByRole("button", { name: "Edit avatar" });
  const button = edit.element().getBoundingClientRect();
  const avatar = edit.element().querySelector<SVGSVGElement>(".agent-avatar")!;
  const label = edit
    .element()
    .querySelector<HTMLElement>(".agent-avatar-edit-label")!;
  const pencil = label.querySelector<SVGSVGElement>(".lucide-pencil")!;
  const face = avatar.getBoundingClientRect();

  expect(face.width).toBe(80);
  expect(face.height).toBe(80);
  expect(
    Math.abs(face.left + face.width / 2 - button.left - button.width / 2),
  ).toBeLessThan(1);
  expect(label.textContent).toBe("Edit");
  expect(label.getBoundingClientRect().top).toBeGreaterThan(face.bottom);
  expect(getComputedStyle(pencil).padding).toBe("0px");
  expect(getComputedStyle(pencil).borderRadius).toBe("0px");
  expect(getComputedStyle(pencil).overflow).toBe("visible");
  expect(pencil.getBoundingClientRect().width).toBe(12);
  expect(pencil.getBoundingClientRect().height).toBe(12);
  await edit.click();
  await page.getByRole("button", { name: "dog", exact: true }).click();
  expect(change).toHaveBeenCalledWith({ animal: "dog", color: "red" });
});

it("confirms membership changes and keeps memories out of general settings", async () => {
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
    const team = page.getByRole("combobox", { name: "Team", exact: true });
    await expect
      .element(page.getByRole("textbox", { name: "Personal memories" }))
      .not.toBeInTheDocument();
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
    await team.selectOptions("project");
    expect(fetchMock.mock.calls).toHaveLength(0);
    await page.getByRole("button", { name: "Move agent", exact: true }).click();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ fromTeamId: null, toTeamId: "project" });
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
    const name = page.getByRole("textbox", {
      name: "Name",
      exact: true,
    });
    await name.fill("First name");
    name.element().blur();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    await name.fill("Latest name");
    await page.getByRole("button", { name: "Close dialog" }).click();
    expect(dismiss).not.toHaveBeenCalled();
    finish(new Response(null, { status: 204 }));
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ name: "Latest name" });
  } finally {
    finish(new Response(null, { status: 204 }));
    fetchMock.mockRestore();
  }
});

it("autosaves profile tweaks on blur and flushes them before dismissal", async () => {
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  const dismiss = vi.fn();

  try {
    await using _screen = await render(
      <AgentDialog
        agent={{
          id: "specialist",
          name: "Reviewer",
          role: "Reviewer",
          description: "Checks APIs",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-03",
        }}
        connected
        onDismiss={dismiss}
      />,
    );
    const role = page.getByRole("textbox", { name: "Role", exact: true });
    await expect.element(role).toHaveValue("Reviewer");
    await role.fill("Release reviewer");
    await page
      .getByRole("textbox", { name: "Description", exact: true })
      .click();
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ role: "Release reviewer" });
    await page
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Checks releases");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)),
    ).toMatchObject({ description: "Checks releases" });
  } finally {
    fetchMock.mockRestore();
  }
});
