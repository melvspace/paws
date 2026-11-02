import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { agentsAtom } from "@paws/client-runtime";
import type { Routine } from "@paws/contracts";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { render } from "../../test/render.tsx";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";

it("edits routines with autosave and flushes instructions before dismissing Settings", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [
        {
          id: "ada",
          name: "Ada",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  let routine: Routine = {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "ada",
    name: "Digest",
    instruction: "Summarize tickets",
    enabled: true,
    missed: "skip",
    timeoutMinutes: 60,
    trigger: { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
    nextAt: "2026-11-03T09:00:00.000Z",
    revision: 1,
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    changedBy: "user",
    deleted: false,
  };
  const writes: unknown[] = [];
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input, init) => {
      const path = String(input);

      if (path === "/api/routine-preview")
        return Response.json(["2026-11-03T09:00:00.000Z"]);
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        routine = {
          ...routine,
          ...body.routine,
          revision: routine.revision + 1,
        };

        return Response.json({ routine });
      }

      return Response.json({ routines: [routine], runs: [], events: [] });
    });
  const dismiss = vi.fn();

  try {
    await using _screen = await render(
      <AppSettingsDialog initialPage="Routines" onDismiss={dismiss} />,
    );
    await page.getByRole("button", { name: "Digest", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Save", exact: true }))
      .not.toBeInTheDocument();
    await page
      .getByRole("textbox", { name: "Instruction", exact: true })
      .fill("Summarize tickets and include owners");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      revision: 1,
      routine: { instruction: "Summarize tickets and include owners" },
    });
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
  } finally {
    fetchMock.mockRestore();
  }
});

it("keeps a failed routine edit visible when dismissal cannot save it", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [
        {
          id: "ada",
          name: "Ada",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  const routine = {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "ada",
    name: "Digest",
    instruction: "Summarize tickets",
    enabled: true,
    missed: "skip",
    timeoutMinutes: 60,
    trigger: { kind: "interval", minutes: 60 },
    nextAt: "2026-11-03T09:00:00.000Z",
    revision: 1,
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    changedBy: "user",
    deleted: false,
  };
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input, init) => {
      if (String(input) === "/api/routine-preview") return Response.json([]);
      if (init?.method === "PATCH")
        return Response.json(
          { error: "Routine changed. Reload before retrying this edit." },
          { status: 409 },
        );

      return Response.json({ routines: [routine], runs: [], events: [] });
    });
  const dismiss = vi.fn();

  try {
    await using _screen = await render(
      <AppSettingsDialog initialPage="Routines" onDismiss={dismiss} />,
    );
    await page.getByRole("button", { name: "Digest", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Instruction", exact: true })
      .fill("Keep this draft");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Routine changed. Reload before retrying this edit.");
    expect(dismiss).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: "Instruction", exact: true }))
      .toHaveValue("Keep this draft");
  } finally {
    fetchMock.mockRestore();
  }
});

it("keeps routine actions compact and advanced execution settings out of the default editor", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [
        {
          id: "ada",
          name: "Ada",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () =>
      Response.json({ routines: [], runs: [], events: [] }),
    );

  try {
    await using _screen = await render(
      <AppSettingsDialog initialPage="Routines" onDismiss={() => {}} />,
    );
    const create = page.getByRole("button", {
      name: "Create routine",
      exact: true,
    });
    await expect.element(create).toBeVisible();
    expect(create.element().getBoundingClientRect().width).toBeLessThan(200);
    await create.click();
    await expect
      .element(page.getByRole("textbox", { name: "Instruction", exact: true }))
      .toBeVisible();
    const advanced =
      document.querySelector<HTMLDetailsElement>(".routine-advanced");
    expect(advanced?.open).toBe(false);
    expect(advanced?.querySelector("input")?.checkVisibility()).toBe(false);
    const instruction = page
      .getByRole("textbox", { name: "Instruction", exact: true })
      .element();
    expect(instruction.getBoundingClientRect().width).toBeGreaterThan(180);
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])("keeps routine editing usable at $width px", async ({ width, height }) => {
  await page.viewport(width, height);
  const agentId = "00000000-0000-4000-8000-000000000002";
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [
        {
          id: agentId,
          name: "Joker",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  const routine: Routine = {
    id: "00000000-0000-4000-8000-000000000001",
    agentId,
    name: "A joke every five minutes",
    instruction:
      "Send a short joke to the main chat. Vary the jokes from previous runs.",
    enabled: true,
    trigger: { kind: "interval", minutes: 5 },
    missed: "skip",
    timeoutMinutes: 2,
    revision: 1,
    nextAt: "2026-11-02T10:45:00.000Z",
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    changedBy: "agent",
    deleted: false,
  };
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input) => {
      if (String(input) === "/api/routine-preview")
        return Response.json([
          "2026-11-02T10:45:00.000Z",
          "2026-11-02T10:50:00.000Z",
        ]);

      return Response.json({ routines: [routine], runs: [], events: [] });
    });

  try {
    await using _screen = await render(
      <AppSettingsDialog initialPage="Routines" onDismiss={() => {}} />,
    );
    await expect
      .element(page.getByRole("button", { name: routine.name, exact: true }))
      .toBeVisible();

    await page.getByRole("button", { name: routine.name, exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Run now", exact: true }))
      .toBeVisible();
    const section = document.querySelector<HTMLElement>(".routines-settings")!;
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1);
    const rows = [
      ...document.querySelectorAll(".routine-fields > .settings-row"),
    ].filter((row) => row.checkVisibility());
    expect(rows.every((row) => row.getBoundingClientRect().height < 160)).toBe(
      true,
    );
  } finally {
    fetchMock.mockRestore();
    await page.viewport(800, 600);
  }
});

it("patches the created routine when the draft changes during creation", async () => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents: [
        {
          id: "ada",
          name: "Ada",
          provider: "codex",
          status: "configured",
          createdAt: "2026-11-01",
        },
      ],
    },
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: {
    path: string;
    method: string;
    body: { routine: Routine; revision?: number };
  }[] = [];
  const id = "00000000-0000-4000-8000-000000000001";
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input, init) => {
      const path = String(input);

      if (path === "/api/routine-preview") return Response.json([]);
      if (init?.method === "POST" || init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, method: init.method, body });

        if (init.method === "POST") await pending;

        return Response.json({
          routine: {
            ...body.routine,
            id,
            agentId: "ada",
            revision: (body.revision ?? 0) + 1,
            createdAt: "2026-11-01",
            updatedAt: "2026-11-01",
            nextAt: null,
            changedBy: "user",
            deleted: false,
          },
        });
      }

      return Response.json({ routines: [], runs: [], events: [] });
    });

  try {
    await using _screen = await render(
      <AppSettingsDialog initialPage="Routines" onDismiss={() => {}} />,
    );
    await page
      .getByRole("button", { name: "Create routine", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Digest");
    const instruction = page.getByRole("textbox", {
      name: "Instruction",
      exact: true,
    });
    await instruction.fill("Original instruction");
    await page
      .getByRole("button", { name: "Create routine", exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    await instruction.fill("Edited during creation");
    release();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
    expect(writes[1]).toMatchObject({
      path: `/api/agents/ada/routines/${id}`,
      body: { revision: 1, routine: { instruction: "Edited during creation" } },
    });
    await expect.element(instruction).toHaveValue("Edited during creation");
  } finally {
    release();
    fetchMock.mockRestore();
  }
});
