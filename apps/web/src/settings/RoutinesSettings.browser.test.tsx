import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { agentsAtom } from "@paws/client-runtime";
import type { Routine } from "@paws/contracts";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { render } from "../../test/render.tsx";
import { useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AgentSettingsPanel } from "./AgentSettingsPanel.tsx";
import { ChatRightPanel } from "../workspace/ChatRightPanel.tsx";
import { Button } from "../components/ui/button.tsx";

function RoutinesPanel({
  onDismiss,
  initialRunId,
}: {
  onDismiss: () => void;
  initialRunId?: string | undefined;
}) {
  const beforeClose = useRef<(() => Promise<void>) | null>(null);
  const { snapshot, connected } = useAtomValue(agentsAtom);

  async function close() {
    try {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();

      await beforeClose.current?.();
      onDismiss();
    } catch {
      // Keep failed edits visible, as in the workspace.
    }
  }

  return (
    <div style={{ display: "flex", width: "100vw", height: "100dvh" }}>
      <ChatRightPanel
        agentId={snapshot.agents[0]!.id}
        open
        maximized={false}
        sheet={window.innerWidth < 760}
        rowWidth={window.innerWidth}
        viewportWidth={window.innerWidth}
        controls={<Button onClick={() => void close()}>Close settings</Button>}
        onClose={() => void close()}
      >
        <AgentSettingsPanel
          agent={snapshot.agents[0]!}
          connected={connected}
          beforeClose={beforeClose}
          onDismiss={onDismiss}
          initialPage="routines"
          initialRunId={initialRunId}
        />
      </ChatRightPanel>
    </div>
  );
}

it.each(["fast", "slow"])(
  "avoids flashing loading text for %s routine responses",
  async (speed) => {
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
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () =>
        speed === "slow"
          ? pending
          : Response.json({ routines: [], runs: [], events: [] }),
      );
    const loadingLabels: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.textContent?.includes("Loading routines…"))
            loadingLabels.push(node.textContent);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      await using _screen = await render(
        <RoutinesPanel onDismiss={() => {}} />,
      );

      if (speed === "slow") {
        await expect
          .element(page.getByRole("status"))
          .toHaveTextContent("Loading routines…");
        finish(Response.json({ routines: [], runs: [], events: [] }));
      }

      await expect
        .element(page.getByText("No routines yet", { exact: true }))
        .toBeVisible();

      if (speed === "fast") expect(loadingLabels).toEqual([]);
    } finally {
      observer.disconnect();
      finish(Response.json({ routines: [], runs: [], events: [] }));
      fetchMock.mockRestore();
    }
  },
);

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
    await using _screen = await render(<RoutinesPanel onDismiss={dismiss} />);
    await page
      .getByRole("switch", { name: "Enable Digest", exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    await expect
      .element(page.getByRole("textbox", { name: "Instruction", exact: true }))
      .not.toBeInTheDocument();
    writes.length = 0;
    await page
      .getByText("Summarize tickets", { exact: true })
      .click({ force: true });
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
      revision: 2,
      routine: { instruction: "Summarize tickets and include owners" },
    });
    await expect.poll(() => dismiss.mock.calls.length).toBe(1);
  } finally {
    fetchMock.mockRestore();
  }
});

it.each(["immediate", "stale refresh"])(
  "reopens saved routines with current values and revision after %s responses",
  async (responseOrder) => {
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
      trigger: { kind: "interval", minutes: 5 },
      nextAt: null,
      revision: 1,
      createdAt: "2026-11-01",
      updatedAt: "2026-11-01",
      changedBy: "user",
      deleted: false,
    };
    const oldRoutine = routine;
    let release: ((response: Response) => void) | undefined;
    let reads = 0;
    const revisions: number[] = [];
    const requests = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input) === "/api/routine-preview") return Response.json([]);

        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          revisions.push(body.revision);

          if (body.revision !== routine.revision)
            return new Response(null, { status: 409 });

          routine = {
            ...routine,
            ...body.routine,
            revision: routine.revision + 1,
          };

          return Response.json({ routine });
        }

        reads++;

        if (reads >= 2) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }

        return Response.json({ routines: [routine], runs: [], events: [] });
      });

    try {
      await using _screen = await render(
        <RoutinesPanel onDismiss={() => {}} />,
      );
      await page.getByRole("button", { name: "Digest", exact: true }).click();

      if (responseOrder === "stale refresh")
        await expect.poll(() => release, { timeout: 4000 }).toBeDefined();

      const instruction = page.getByRole("textbox", {
        name: "Instruction",
        exact: true,
      });
      await instruction.fill("Include owners");
      await page.getByRole("button", { name: "Back to routines" }).click();

      if (responseOrder === "stale refresh") {
        release?.(
          Response.json({ routines: [oldRoutine], runs: [], events: [] }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }

      await expect
        .element(page.getByText("Include owners", { exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "Digest", exact: true }).click();
      await expect.element(instruction).toHaveValue("Include owners");
      await instruction.fill("Include owners and deadlines");
      await page.getByRole("button", { name: "Back to routines" }).click();
      await expect
        .element(
          page.getByText("Include owners and deadlines", { exact: true }),
        )
        .toBeVisible();
      expect(revisions).toEqual([1, 2]);
    } finally {
      release?.(Response.json({ routines: [routine], runs: [], events: [] }));
      requests.mockRestore();
    }
  },
);

function routineListFixture(): Routine {
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

  return {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "ada",
    name: "Digest",
    instruction: "Summarize tickets",
    enabled: true,
    missed: "skip",
    timeoutMinutes: 60,
    trigger: { kind: "interval", minutes: 5 },
    nextAt: null,
    revision: 1,
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    changedBy: "user",
    deleted: false,
  };
}

it("awaits a pending list toggle before opening the current routine revision", async () => {
  let routine = routineListFixture();
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const revisions: number[] = [];
  const requests = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input, init) => {
      if (String(input) === "/api/routine-preview") return Response.json([]);

      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        revisions.push(body.revision);

        if (body.revision !== routine.revision)
          return new Response(null, { status: 409 });

        routine = {
          ...routine,
          ...body.routine,
          revision: routine.revision + 1,
        };

        return revisions.length === 1 ? pending : Response.json({ routine });
      }

      return Response.json({ routines: [routine], runs: [], events: [] });
    });

  try {
    await using _screen = await render(<RoutinesPanel onDismiss={() => {}} />);
    await page.getByRole("switch", { name: "Enable Digest" }).click();
    await expect.poll(() => revisions.length).toBe(1);
    await page.getByRole("button", { name: "Digest", exact: true }).click();
    const instruction = page.getByRole("textbox", {
      name: "Instruction",
      exact: true,
    });
    await expect.element(instruction).not.toBeInTheDocument();
    finish(Response.json({ routine }));
    await instruction.fill("Include owners");
    await page.getByRole("button", { name: "Back to routines" }).click();
    await expect
      .element(page.getByText("Include owners", { exact: true }))
      .toBeVisible();
    expect(revisions).toEqual([1, 2]);
  } finally {
    finish(Response.json({ routine }));
    requests.mockRestore();
  }
});

it("removes a deleted routine immediately and ignores an older refresh", async () => {
  const routine = routineListFixture();
  let reads = 0;
  let finish: ((response: Response) => void) | undefined;
  const requests = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (input, init) => {
      if (String(input) === "/api/routine-preview") return Response.json([]);
      if (init?.method === "DELETE") return Response.json({});

      reads++;

      if (reads > 1)
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });

      return Response.json({ routines: [routine], runs: [], events: [] });
    });

  try {
    await using _screen = await render(<RoutinesPanel onDismiss={() => {}} />);
    await page.getByRole("button", { name: "Digest", exact: true }).click();
    await expect.poll(() => finish, { timeout: 4000 }).toBeDefined();
    await page
      .getByRole("button", { name: "Delete routine", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm deletion" }).click();
    await expect
      .element(page.getByText("No routines yet", { exact: true }))
      .toBeVisible();
    finish?.(Response.json({ routines: [routine], runs: [], events: [] }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await expect
      .element(page.getByRole("button", { name: "Digest", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("No routines yet", { exact: true }))
      .toBeVisible();
  } finally {
    finish?.(Response.json({ routines: [], runs: [], events: [] }));
    requests.mockRestore();
  }
});

it.each(["toggle", "delete"])(
  "awaits a pending routine %s and retains its failure when closing settings",
  async (action) => {
    const routine = routineListFixture();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const requests = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input) === "/api/routine-preview") return Response.json([]);
        if (init?.method === "PATCH" || init?.method === "DELETE")
          return pending;

        return Response.json({ routines: [routine], runs: [], events: [] });
      });
    const dismiss = vi.fn();

    try {
      await using _screen = await render(<RoutinesPanel onDismiss={dismiss} />);

      if (action === "toggle")
        await page.getByRole("switch", { name: "Enable Digest" }).click();
      else {
        await page.getByRole("button", { name: "Digest", exact: true }).click();
        await page
          .getByRole("button", { name: "Delete routine", exact: true })
          .click();
        await page.getByRole("button", { name: "Confirm deletion" }).click();
      }

      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
      expect(dismiss).not.toHaveBeenCalled();
      finish(
        Response.json({ error: "Please retry this change." }, { status: 500 }),
      );
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Error: Please retry this change.");
      expect(dismiss).not.toHaveBeenCalled();

      if (action === "toggle") {
        await expect
          .element(page.getByRole("switch", { name: "Enable Digest" }))
          .toBeEnabled();
      } else {
        await expect
          .element(
            page.getByRole("textbox", { name: "Instruction", exact: true }),
          )
          .toHaveValue(routine.instruction);
        await expect
          .element(page.getByRole("button", { name: "Confirm deletion" }))
          .toBeEnabled();
      }
    } finally {
      finish(
        Response.json({ error: "Please retry this change." }, { status: 500 }),
      );
      requests.mockRestore();
    }
  },
);

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
    await using _screen = await render(<RoutinesPanel onDismiss={dismiss} />);
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
    await using _screen = await render(<RoutinesPanel onDismiss={() => {}} />);
    const create = page.getByRole("button", {
      name: "New",
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
    await using _screen = await render(<RoutinesPanel onDismiss={() => {}} />);
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

it.each([
  "instruction",
  "filters",
  "retry",
  "revert retry",
  "dismissal",
  "navigation",
  "failed dismissal",
])("preserves pending creation during %s", async (scenario) => {
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
        {
          id: "grace",
          name: "Grace",
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
        if (
          (scenario === "retry" ||
            scenario === "revert retry" ||
            scenario === "failed dismissal") &&
          writes.length === 2
        )
          return Response.json({ error: "Follow-up failed" }, { status: 500 });

        return Response.json({
          ...(init.method === "POST"
            ? {
                webhook: {
                  endpoint: `/hooks/routines/${id}`,
                  secret: "original-secret",
                },
              }
            : {}),
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

  const dismiss = vi.fn();

  try {
    await using _screen = await render(<RoutinesPanel onDismiss={dismiss} />);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Digest");
    const instruction = page.getByRole("textbox", {
      name: "Instruction",
      exact: true,
    });
    await instruction.fill("Original instruction");
    await page
      .getByRole("combobox", { name: "Trigger", exact: true })
      .selectOptions("webhook");

    if (scenario === "filters") {
      await page
        .getByRole("button", { name: "Add filter", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Field", exact: true })
        .fill("repo");
      await page
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("paws");
    }
    await page
      .getByRole("button", { name: "Create routine", exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    if (scenario === "filters") {
      await page
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("updated");
    } else {
      await instruction.fill("Edited during creation");
    }

    if (scenario === "dismissal" || scenario === "failed dismissal") {
      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
      expect(dismiss).not.toHaveBeenCalled();
    }

    if (scenario === "navigation") {
      await page
        .getByRole("button", { name: "Back to routines", exact: true })
        .click();
      await expect.element(instruction).toBeVisible();
    }

    release();
    await expect.poll(() => writes.length).toBe(2);
    if (
      scenario === "retry" ||
      scenario === "revert retry" ||
      scenario === "failed dismissal"
    ) {
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Follow-up failed");
      expect(dismiss).not.toHaveBeenCalled();
      if (scenario === "revert retry") {
        await instruction.fill("Original instruction");
        await page.getByRole("textbox", { name: "Name", exact: true }).click();
      } else {
        await page
          .getByRole("button", { name: "Create routine", exact: true })
          .click();
        await expect.poll(() => writes.length).toBe(3);
      }
      await expect
        .element(
          page.getByRole("textbox", { name: "Signing secret", exact: true }),
        )
        .toHaveValue("original-secret");
    }

    expect(writes.map((write) => write.method)).toEqual(
      scenario === "retry" || scenario === "failed dismissal"
        ? ["POST", "PATCH", "PATCH"]
        : ["POST", "PATCH"],
    );
    expect(writes[1]).toMatchObject({
      path: `/api/agents/ada/routines/${id}`,
      body: {
        revision: 1,
        routine:
          scenario === "filters"
            ? { trigger: { filters: [{ path: "repo", value: "updated" }] } }
            : { instruction: "Edited during creation" },
      },
    });
    if (scenario === "navigation") {
      await expect
        .element(page.getByRole("heading", { name: "Routines", exact: true }))
        .toBeVisible();
      await expect.element(instruction).not.toBeInTheDocument();
    } else if (scenario === "dismissal") {
      await expect.poll(() => dismiss.mock.calls.length).toBe(1);
    } else if (scenario === "filters") {
      await expect
        .element(page.getByRole("textbox", { name: "Value", exact: true }))
        .toHaveValue("updated");
    } else {
      await expect
        .element(instruction)
        .toHaveValue(
          scenario === "revert retry"
            ? "Original instruction"
            : "Edited during creation",
        );
    }
  } finally {
    release();
    fetchMock.mockRestore();
  }
});

it.each(["link", "pagination", "missing"])(
  "opens retained run history through %s",
  async (mode) => {
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
    const oldId = "00000000-0000-4000-8000-000000000001";
    const run = {
      id: oldId,
      agentId: "ada",
      routineId: "digest",
      status: "waiting",
      source: "manual",
      createdAt: "2026-11-01T00:00:00Z",
      selection: { providerId: "codex", modelId: "model", options: {} },
    };
    const newest = {
      ...run,
      id: "00000000-0000-4000-8000-000000000002",
      status: "cancelled",
      createdAt: "2026-11-02T00:00:00Z",
    };
    const paths: string[] = [];
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input) => {
        const path = String(input);
        paths.push(path);

        if (path.endsWith("/details")) {
          if (mode === "missing")
            return Response.json({ error: "Run not found." }, { status: 404 });

          return Response.json(run);
        }

        if (path === `/api/routine-runs/${oldId}`)
          return Response.json({
            agentId: oldId,
            revision: 1,
            status: "idle",
            error: null,
            selection: run.selection,
            messages: [],
          });
        if (path.includes("?before=2"))
          return Response.json({
            routines: [],
            runs: [run],
            events: [],
            nextRunCursor: null,
          });

        return Response.json({
          routines: [],
          runs: [newest],
          events: [],
          nextRunCursor: 2,
        });
      });

    try {
      await using _screen = await render(
        <RoutinesPanel
          initialRunId={mode === "pagination" ? undefined : oldId}
          onDismiss={() => {}}
        />,
      );

      if (mode === "missing") {
        await expect
          .element(page.getByRole("alert"))
          .toHaveTextContent("Run not found.");

        return;
      }

      if (mode === "pagination") {
        await page
          .getByRole("button", { name: "Older runs", exact: true })
          .click();
        await expect
          .poll(() => paths.includes("/api/agents/ada/routines?before=2"))
          .toBe(true);
        await page.getByRole("button", { name: /^Deleted routine/ }).click();
      }

      await expect
        .element(page.getByRole("textbox", { name: "Message", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Cancel run", exact: true }))
        .toBeVisible();
      expect(paths).not.toContain(`/api/routine-runs/${oldId}`);

      if (mode === "link")
        expect(paths).toContain(`/api/routine-runs/${oldId}/details`);
      if (mode === "pagination") {
        await page
          .getByRole("button", { name: "Back to routines", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Newer runs", exact: true })
          .click();
        await expect
          .element(
            page.getByRole("button", { name: "Older runs", exact: true }),
          )
          .toBeEnabled();
        await expect
          .element(
            page.getByRole("button", { name: "Newer runs", exact: true }),
          )
          .toBeDisabled();
      }
    } finally {
      fetchMock.mockRestore();
    }
  },
);
