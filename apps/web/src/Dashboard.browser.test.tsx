import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  agentsAtom,
  conversationsAtom,
  providersAtom,
} from "@paws/client-runtime";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { render } from "../test/render.tsx";
import { Dashboard } from "./Dashboard.tsx";

vi.mock("@paws/client-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paws/client-runtime")>()),
  connectAgents: () => () => {},
}));

const agents = ["Ada", "Grace"].map((name) => ({
  id: name.toLowerCase(),
  name,
  provider: "codex" as const,
  status: "configured" as const,
  createdAt: "2026-11-01",
}));

beforeEach(async () => {
  await page.viewport(1440, 900);
  location.hash = "agent-ada";

  for (const agent of agents) {
    localStorage.setItem(
      `paws.workspace.${agent.id}`,
      JSON.stringify({ sidebarOpen: false }),
    );
  }

  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: { agents },
  });
  appAtomRegistry.set(providersAtom, { providers: [], error: null });
  appAtomRegistry.set(conversationsAtom, []);
});

afterEach(async () => {
  vi.restoreAllMocks();

  for (const agent of agents) {
    localStorage.removeItem(`paws.workspace.${agent.id}`);
    localStorage.removeItem(`paws.panel-width.${agent.id}`);
  }

  history.replaceState(null, "", location.pathname + location.search);
  appAtomRegistry.set(agentsAtom, {
    connected: false,
    error: null,
    snapshot: { agents: [] },
  });
  await page.viewport(800, 600);
});

function mockRequests(
  save: () => Promise<Response> = async () =>
    new Response(null, { status: 204 }),
) {
  return vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);

    if (init?.method === "PATCH") return save();
    if (path.endsWith("/routines"))
      return Response.json({ routines: [], runs: [], events: [] });

    return Response.json({
      agentId: path.includes("grace") ? "grace" : "ada",
      revision: 0,
      status: "idle",
      error: null,
      selection: null,
      messages: [],
    });
  });
}

it("opens another agent's settings and only offers implemented surfaces", async () => {
  const requests = mockRequests();
  await using _screen = await render(<Dashboard />);
  // Focus makes the compact management control visible.
  page.getByRole("link", { name: "Grace", exact: true }).element().focus();
  await page
    .getByRole("button", { name: "Settings for Grace", exact: true })
    .click();
  await expect
    .element(page.getByRole("complementary", { name: "Agent settings" }))
    .toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toHaveValue("Grace");
  await expect
    .element(page.getByRole("textbox", { name: "Message Grace" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Routines", exact: true }))
    .toBeVisible();
  expect(
    requests.mock.calls.some(
      ([path]) => String(path) === "/api/agents/grace/routines",
    ),
  ).toBe(true);
  await expect
    .element(page.getByRole("tablist", { name: "Agents", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Add sidebar tab" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Toggle terminal drawer" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Close Agent settings tab" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Open a surface" }))
    .toBeVisible();
  const surfaces = document.querySelector(".surface-picker")!;
  expect(surfaces.querySelectorAll("button")).toHaveLength(1);
  expect(surfaces.textContent).toBe("Open a surfaceAgent settings");
  await page.getByRole("button", { name: "Add sidebar tab" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Files", exact: true }))
    .not.toBeInTheDocument();
  await page
    .getByRole("menuitem", { name: "Agent settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle right panel", exact: true })
    .click();
  await expect
    .element(page.getByRole("complementary", { name: "Agent settings" }))
    .not.toBeInTheDocument();
});

it("awaits pending settings saves before opening Routines or switching agents", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const requests = mockRequests(() => pending);

  try {
    await using _screen = await render(<Dashboard />);
    page.getByRole("link", { name: "Grace", exact: true }).element().focus();
    await page
      .getByRole("button", { name: "Settings for Grace", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Amazing Grace");
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    await expect
      .poll(
        () =>
          requests.mock.calls.filter(([, init]) => init?.method === "PATCH")
            .length,
      )
      .toBe(1);
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .toBeVisible();
    expect(
      requests.mock.calls.some(([path]) => String(path).endsWith("/routines")),
    ).toBe(false);
    release(new Response(null, { status: 204 }));
    await expect
      .element(page.getByRole("heading", { name: "Routines", exact: true }))
      .toBeVisible();
    await page
      .getByRole("button", { name: "Agent settings", exact: true })
      .click();
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .toHaveValue("Amazing Grace");
    await page.getByRole("link", { name: "Ada", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Message Ada" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .not.toBeInTheDocument();
  } finally {
    release(new Response(null, { status: 204 }));
  }
});

it("keeps failed edits visible when closing the sidebar or navigating away", async () => {
  const requests = mockRequests(
    async () => new Response(null, { status: 500 }),
  );
  await using _screen = await render(<Dashboard />);
  page.getByRole("link", { name: "Grace", exact: true }).element().focus();
  await page
    .getByRole("button", { name: "Settings for Grace", exact: true })
    .click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Edited Grace");
  await page
    .getByRole("button", { name: "Toggle right panel", exact: true })
    .click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Could not save agent settings. Check your connection and fields.",
    );
  await expect.element(name).toHaveValue("Edited Grace");
  await page.getByRole("button", { name: "Close Agent settings tab" }).click();
  await expect.element(name).toBeVisible();
  await expect
    .element(page.getByRole("tab", { name: "Agent settings", exact: true }))
    .toBeVisible();
  await page.getByRole("link", { name: "Ada", exact: true }).click();
  await expect
    .poll(
      () =>
        requests.mock.calls.filter(([, init]) => init?.method === "PATCH")
          .length,
    )
    .toBeGreaterThanOrEqual(2);
  expect(location.hash).toBe("#agent-grace");
  await expect.element(name).toHaveValue("Edited Grace");
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect.element(name).toBeVisible();
  expect(
    requests.mock.calls.some(([path]) => String(path).endsWith("/routines")),
  ).toBe(false);
});

it("uses the sidebar sheet on a narrow screen and flushes edits on Escape", async () => {
  await page.viewport(390, 844);
  const requests = mockRequests();
  await using _screen = await render(<Dashboard />);
  await page
    .getByRole("button", { name: "Settings for Ada", exact: true })
    .click();
  await expect
    .element(page.getByRole("dialog", { name: "Agent settings" }))
    .toBeVisible();
  const avatar = page.getByRole("button", { name: "Edit avatar" }).element();
  const avatarBounds = avatar.getBoundingClientRect();
  const avatarContainer = avatar.parentElement!.getBoundingClientRect();
  expect(
    Math.abs(
      avatarBounds.left +
        avatarBounds.width / 2 -
        avatarContainer.left -
        avatarContainer.width / 2,
    ),
  ).toBeLessThan(1);
  const settings = document.querySelector<HTMLElement>(
    ".agent-settings-scroll",
  )!;
  expect(settings.scrollWidth).toBeLessThanOrEqual(settings.clientWidth + 1);
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Mobile Ada");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Agent settings" }))
    .not.toBeInTheDocument();
  expect(
    requests.mock.calls.some(
      ([, init]) =>
        init?.method === "PATCH" && String(init.body).includes("Mobile Ada"),
    ),
  ).toBe(true);
});

it.each(["hashchange", "popstate"])(
  "retains failed edits during %s navigation and restores the accepted URL",
  async (event) => {
    const requests = mockRequests(
      async () => new Response(null, { status: 500 }),
    );
    await using _screen = await render(<Dashboard />);
    await page
      .getByRole("button", { name: "Settings for Ada", exact: true })
      .last()
      .click();
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Unsaved Ada");

    if (event === "hashchange") location.hash = "agent-grace";
    else {
      history.pushState(null, "", "#agent-grace");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    await expect
      .poll(() =>
        requests.mock.calls.some(([, init]) => init?.method === "PATCH"),
      )
      .toBe(true);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(name).toHaveValue("Unsaved Ada");
    expect(location.hash).toBe("#agent-ada");
    await expect
      .element(page.getByRole("textbox", { name: "Message Ada" }))
      .toBeVisible();
  },
);

it("preserves failed settings drafts while changing between sidebar and sheet", async () => {
  mockRequests(async () => new Response(null, { status: 500 }));
  await using _screen = await render(<Dashboard />);
  await page
    .getByRole("button", { name: "Settings for Ada", exact: true })
    .last()
    .click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Unsaved Ada");
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  const editor = name.element();
  await page.viewport(390, 844);
  await expect
    .element(page.getByRole("dialog", { name: "Agent settings" }))
    .toBeVisible();
  await expect.element(name).toHaveValue("Unsaved Ada");
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(name.element()).toBe(editor);
  await page.viewport(1440, 900);
  await expect
    .element(page.getByRole("complementary", { name: "Agent settings" }))
    .toBeVisible();
  await expect.element(name).toHaveValue("Unsaved Ada");
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(name.element()).toBe(editor);
});

it("awaits pending edits before accepting browser hash navigation", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const requests = mockRequests(() => pending);

  try {
    await using _screen = await render(<Dashboard />);
    await page
      .getByRole("button", { name: "Settings for Ada", exact: true })
      .last()
      .click();
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Saved Ada");
    location.hash = "agent-grace";
    await expect
      .poll(() =>
        requests.mock.calls.some(([, init]) => init?.method === "PATCH"),
      )
      .toBe(true);
    expect(location.hash).toBe("#agent-ada");
    await expect.element(name).toHaveValue("Saved Ada");
    finish(new Response(null, { status: 204 }));
    await expect
      .element(page.getByRole("textbox", { name: "Message Grace" }))
      .toBeVisible();
    expect(location.hash).toBe("#agent-grace");
    await expect.element(name).not.toBeInTheDocument();
  } finally {
    finish(new Response(null, { status: 204 }));
  }
});

it.each([
  { button: "New agent", teamId: null },
  { button: "New agent in Project", teamId: "project" },
])("creates an agent in the context of $button", async ({ button, teamId }) => {
  appAtomRegistry.set(agentsAtom, {
    connected: true,
    error: null,
    snapshot: {
      agents,
      teams: [
        { id: "project", name: "Project", memory: "", createdAt: "2026-11-01" },
      ],
    },
  });
  const created: unknown[] = [];
  vi.spyOn(window, "fetch").mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      const input = JSON.parse(String(init.body));
      created.push(input);

      return Response.json({ ...agents[0], ...input, id: "created" });
    }

    return Response.json([]);
  });
  await using _screen = await render(<Dashboard />);
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Team", exact: true }))
    .not.toBeInTheDocument();

  await expect
    .element(
      page.getByRole("textbox", { name: "Personal memories", exact: true }),
    )
    .not.toBeInTheDocument();

  if (teamId) {
    await expect
      .element(page.getByRole("switch", { name: "Sandbox", exact: true }))
      .not.toBeInTheDocument();
  } else {
    await expect
      .element(page.getByRole("switch", { name: "Sandbox", exact: true }))
      .not.toBeChecked();
  }

  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("New assistant");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({
    name: "New assistant",
    teamId,
    sandbox: false,
  });
});
