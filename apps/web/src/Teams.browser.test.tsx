import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { agentsAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { AppSettingsDialog } from "./settings/AppSettingsDialog.tsx";
import type { Agent, Team } from "@paws/contracts";

const teams: Team[] = [
  {
    id: "project-a",
    name: "Project A",
    memory: "Project conventions",
    createdAt: "2026-11-01",
  },
  { id: "project-b", name: "Project B", memory: "", createdAt: "2026-11-01" },
];
const agents: Agent[] = [
  {
    id: "ada",
    name: "Ada",
    teamIds: ["project-a"],
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
];

afterEach(() => {
  vi.unstubAllGlobals();
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents: [] },
    connected: false,
    error: null,
  });
});

it("shows every team, including empty teams, and collapses its agents independently", async () => {
  await using _screen = await render(
    <AgentSidebar
      agents={agents}
      teams={teams}
      selectedId="ada"
      connected
      onCreate={() => {}}
      onSettings={() => {}}
      onAppSettings={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Project A 1" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Project B" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Ada", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Project A 1" }).click();
  await expect
    .element(page.getByRole("link", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("link", { name: "Grace", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Project A 1" }).click();
  await expect
    .element(page.getByRole("link", { name: "Ada", exact: true }))
    .toBeVisible();
});

it("manages team membership and shared memories from the existing Settings dialog", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return Response.json([]);

      requests.push({ url, body: JSON.parse(String(init.body)) });

      return Response.json(
        url === "/api/teams/project-a"
          ? { ...teams[0], ...JSON.parse(String(init.body)) }
          : {},
      );
    }),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await page.getByRole("checkbox", { name: "Grace" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({
    url: "/api/agents/grace",
    body: { name: "Grace", teamIds: ["project-a"] },
  });
  await page.getByRole("tab", { name: "Memories", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Shared memories" }))
    .toHaveValue("Project conventions");
  await page
    .getByRole("textbox", { name: "Shared memories" })
    .fill("Updated project context");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    url: "/api/teams/project-a",
    body: {
      memory: "Updated project context",
      expected: { memory: "Project conventions" },
    },
  });
  await expect
    .element(page.getByRole("button", { name: "Save team", exact: true }))
    .not.toBeInTheDocument();
});

it("moves an idle agent into a collapsed team and reports failed drops", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AgentSidebar
      agents={agents}
      teams={teams}
      selectedId="ada"
      connected
      onCreate={() => {}}
      onSettings={() => {}}
      onAppSettings={() => {}}
    />,
  );
  const source = page
    .getByRole("link", { name: "Ada", exact: true })
    .element()
    .closest("li")!;
  expect(source.draggable).toBe(true);
  await page.getByRole("button", { name: "Project B" }).click();
  const target = page.getByRole("button", { name: "Project B" }).element();

  async function drag() {
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer }),
    );
    await expect.poll(() => source.dataset.dragging).toBe("true");
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
    target.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
  }

  await drag();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/agents/ada/move",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ fromTeamId: "project-a", toTeamId: "project-b" }),
    }),
  );
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Project B" }))
    .toHaveAttribute("aria-expanded", "true");
  fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
  await drag();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Only idle agents can move between teams.");
});

it("prevents dragging an agent that is working", async () => {
  const { conversationsAtom } = await import("@paws/client-runtime");
  appAtomRegistry.set(conversationsAtom, [
    {
      agentId: "ada",
      revision: 0,
      status: "running",
      error: null,
      selection: null,
      messages: [],
    },
  ]);

  try {
    await using _screen = await render(
      <AgentSidebar
        agents={agents}
        teams={teams}
        selectedId="ada"
        connected
        onCreate={() => {}}
        onSettings={() => {}}
        onAppSettings={() => {}}
      />,
    );
    const source = page
      .getByRole("link", { name: "Ada", exact: true })
      .element()
      .closest("li")!;
    expect(source.draggable).toBe(false);
    const event = new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    });
    source.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  } finally {
    appAtomRegistry.set(conversationsAtom, []);
  }
});

it("hides empty Unassigned and keeps real empty teams without repeated empty copy", async () => {
  await using _screen = await render(
    <AgentSidebar
      agents={[agents[0]!]}
      teams={teams}
      selectedId="ada"
      connected
      onCreate={() => {}}
      onSettings={() => {}}
      onAppSettings={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Unassigned", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Project B", exact: true }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("No agents in this team");
});

it("opens integration forms on demand and adds configuration and authentication in one action", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url, body });

      return url.endsWith("/credentials")
        ? new Response(null, { status: 204 })
        : Response.json({ ...teams[0], ...body });
    }),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await expect.element(page.getByLabelText("Command")).not.toBeInTheDocument();
  await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  await expect.element(page.getByLabelText("Command")).not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "New integration", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("pachca");
  await page.getByLabelText("Command").fill("node");
  await page.getByLabelText("Arguments").fill("/workspace/pachca.js");
  await page.getByLabelText("Credential variable").fill("PACHCA_TOKEN");
  await page
    .getByLabelText("Credential", { exact: true })
    .fill("fixture-secret");
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toMatchObject({
    url: "/api/teams/project-a",
    body: {
      integrations: [
        {
          id: "pachca",
          kind: "cli",
          command: "node",
          args: ["/workspace/pachca.js"],
        },
      ],
    },
  });
  expect(requests[1]).toMatchObject({
    url: "/api/teams/project-a/integrations/pachca/credentials",
    body: { name: "PACHCA_TOKEN", value: "fixture-secret" },
  });
  await expect.element(page.getByLabelText("Command")).not.toBeInTheDocument();
});

it("keeps unsaved team memories open on failure and retries when closing Settings", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  const dismiss = vi.fn();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={dismiss} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Memories", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Shared memories" })
    .fill("Keep this edit");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(dismiss).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("textbox", { name: "Shared memories" }))
    .toHaveValue("Keep this edit");
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    Response.json({ ...teams[0], ...JSON.parse(String(init?.body)) }),
  );
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.poll(() => dismiss.mock.calls.length).toBe(1);
});

it("retains failed credentials when switching team tabs or returning to the team list", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: {
      agents,
      teams: [
        {
          ...teams[0]!,
          integrations: [{ id: "tool", kind: "cli", command: "node" }],
        },
      ],
    },
    connected: true,
    error: null,
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  await page.getByRole("button", { name: "tool CLI", exact: true }).click();
  await page.getByLabelText("Credential variable").fill("TOKEN");
  await page.getByLabelText("Credential", { exact: true }).fill("keep-secret");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not save authentication. Try again.");
  await expect
    .element(page.getByLabelText("Credential", { exact: true }))
    .toHaveValue("keep-secret");
  await page
    .getByRole("button", { name: "Back to teams", exact: true })
    .click();
  await expect
    .element(page.getByLabelText("Credential", { exact: true }))
    .toHaveValue("keep-secret");
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toBeVisible();
});

it("reloads conflicting team edits so Settings can recover and continue saving", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  let current = { ...teams[0]!, memory: "Updated by agent" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ agents, teams: [current] });

      const input = JSON.parse(String(init.body));

      if (input.expected.memory !== current.memory)
        return new Response(null, { status: 400 });

      current = { ...current, memory: input.memory };

      return Response.json(current);
    }),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Memories", exact: true }).click();
  await page.getByLabelText("Shared memories").fill("Conflicting edit");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "Discard team edits", exact: true })
    .click();
  await expect
    .element(page.getByLabelText("Shared memories"))
    .toHaveValue("Updated by agent");
  await page.getByLabelText("Shared memories").fill("New edit");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toBeVisible();
  expect(current.memory).toBe("New edit");
});

it("flushes credentials after new integration configuration succeeds but authentication fails", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/credentials"))
        return new Response(null, { status: fail ? 500 : 204 });

      return Response.json({ ...teams[0], ...JSON.parse(String(init?.body)) });
    }),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  await page
    .getByRole("button", { name: "New integration", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("tool");
  await page.getByLabelText("Command").fill("node");
  await page.getByLabelText("Credential variable").fill("TOKEN");
  await page.getByLabelText("Credential", { exact: true }).fill("keep-secret");
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect
    .element(page.getByLabelText("Credential", { exact: true }))
    .toHaveValue("keep-secret");
  await page
    .getByRole("button", { name: "Back to teams", exact: true })
    .click();
  await expect
    .element(page.getByLabelText("Credential", { exact: true }))
    .toHaveValue("keep-secret");
  fail = false;
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toBeVisible();
});

it.each(["General", "Back to integrations"])(
  "waits for initial integration creation before navigating via %s",
  async (navigation) => {
    appAtomRegistry.set(agentsAtom, {
      snapshot: { agents, teams },
      connected: true,
      error: null,
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/credentials"))
          return new Response(null, { status: 500 });

        await gate;

        return Response.json({
          ...teams[0],
          ...JSON.parse(String(init?.body)),
        });
      }),
    );
    await using _screen = await render(
      <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
    );
    await page.getByRole("button", { name: "Project A", exact: true }).click();
    await page.getByRole("tab", { name: "Integrations", exact: true }).click();
    await page
      .getByRole("button", { name: "New integration", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("tool");
    await page.getByLabelText("Command").fill("node");
    await page.getByLabelText("Credential variable").fill("TOKEN");
    await page
      .getByLabelText("Credential", { exact: true })
      .fill("keep-secret");
    await page
      .getByRole("button", { name: "Add integration", exact: true })
      .click();
    if (navigation === "General")
      await page.getByRole("tab", { name: "General", exact: true }).click();
    else
      await page
        .getByRole("button", { name: "Back to integrations", exact: true })
        .click();
    release!();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect
      .element(page.getByLabelText("Credential", { exact: true }))
      .toHaveValue("keep-secret");
    await expect
      .element(page.getByRole("tab", { name: "Integrations", exact: true }))
      .toHaveAttribute("aria-selected", "true");
  },
);

it("rejects duplicate integration names during creation", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: {
      agents,
      teams: [
        {
          ...teams[0]!,
          integrations: [{ id: "tool", kind: "cli", command: "node" }],
        },
      ],
    },
    connected: true,
    error: null,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  await page
    .getByRole("button", { name: "New integration", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("tool");
  await page.getByLabelText("Command").fill("replacement");
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("An integration with this name already exists.");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("allows discarding edits when the team was deleted elsewhere", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method
        ? new Response(null, { status: 404 })
        : Response.json({ agents, teams: [] }),
    ),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Deleted team");
  await page
    .getByRole("button", { name: "Back to teams", exact: true })
    .click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "Discard team edits", exact: true })
    .click();
  await expect
    .element(page.getByRole("button", { name: "New team", exact: true }))
    .toBeVisible();
});

it("retries failed integration creation without treating its draft as a duplicate", async () => {
  appAtomRegistry.set(agentsAtom, {
    snapshot: { agents, teams },
    connected: true,
    error: null,
  });
  let fail = true;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    fail
      ? new Response(null, { status: 500 })
      : Response.json({ ...teams[0], ...JSON.parse(String(init?.body)) }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Teams" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Project A", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  await page
    .getByRole("button", { name: "New integration", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("tool");
  await page.getByLabelText("Command").fill("node");
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect.element(page.getByRole("alert").last()).toBeVisible();
  fail = false;
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await expect
    .element(page.getByRole("button", { name: "tool CLI", exact: true }))
    .toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
