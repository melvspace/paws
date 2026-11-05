import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { environmentDestination } from "./environmentNavigation.ts";
import type { Agent } from "@paws/contracts";
import type { EnvironmentRoster } from "@paws/client-runtime";

const agent = {
  id: "same-agent",
  name: "Ada",
  teamId: "same-team",
  provider: "codex" as const,
  status: "configured" as const,
  createdAt: "2026-11-05",
};
const rosters: readonly EnvironmentRoster[] = [
  {
    id: null,
    name: "Desktop",
    connected: true,
    error: null,
    snapshot: {
      agents: [agent],
      teams: [
        {
          id: "same-team",
          name: "Project",
          memory: "",
          createdAt: "2026-11-05",
        },
        {
          id: "empty-team",
          name: "Empty",
          memory: "",
          createdAt: "2026-11-05",
        },
      ],
    },
  },
  {
    id: "laptop",
    name: "Laptop",
    connected: true,
    error: null,
    snapshot: {
      agents: [{ ...agent, name: "Grace" }],
      teams: [
        {
          id: "same-team",
          name: "Project",
          memory: "",
          createdAt: "2026-11-05",
        },
        {
          id: "other-team",
          name: "Other",
          memory: "",
          createdAt: "2026-11-05",
        },
      ],
    },
  },
];

function Sidebar({
  sources = rosters,
  onNavigate = vi.fn(),
}: {
  sources?: readonly EnvironmentRoster[];
  onNavigate?: (agent: Agent, environmentId?: string | null) => void;
}) {
  return (
    <AgentSidebar
      agents={[agent]}
      selectedId="same-agent"
      connected
      environments={sources}
      activeEnvironmentId={null}
      onCreate={() => {}}
      onCreateTeam={() => {}}
      onTeamSettings={() => {}}
      onSettings={() => {}}
      onAppSettings={() => {}}
      onNavigate={onNavigate}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", location.pathname);
});

it("shows every machine's teams and agents without an environment selector and scopes selection and navigation", async () => {
  const navigate = vi.fn();
  await using _screen = await render(<Sidebar onNavigate={navigate} />);
  const desktop = page.getByRole("region", { name: "Desktop environment" });
  const laptop = page.getByRole("region", { name: "Laptop environment" });
  await expect
    .element(desktop.getByRole("button", { name: "Empty", exact: true }))
    .toBeVisible();
  await expect
    .element(desktop.getByRole("link", { name: "Ada", exact: true }))
    .toHaveAttribute("aria-current", "page");
  const remote = laptop.getByRole("link", { name: "Grace", exact: true });
  await expect.element(remote).not.toHaveAttribute("aria-current");
  const destination = new URL(
    remote.element().getAttribute("href")!,
    location.href,
  );
  expect(destination.searchParams.get("environment")).toBe("laptop");
  expect(destination.hash).toBe("#agent-same-agent");
  await expect
    .element(page.getByRole("button", { name: "Environment", exact: true }))
    .not.toBeInTheDocument();
  await remote.click();
  expect(navigate).toHaveBeenCalledWith({ ...agent, name: "Grace" }, "laptop");
  await desktop.getByRole("button", { name: "Project", exact: true }).click();
  await expect
    .element(desktop.getByRole("link", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(remote).toBeVisible();
  await page.getByRole("searchbox", { name: "Search agents" }).fill("Grace");
  await expect.element(remote).toBeVisible();
});

it("rejects cross-machine drops and routes same-machine moves to their owning server", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(<Sidebar />);
  const laptop = page.getByRole("region", { name: "Laptop environment" });
  const desktop = page.getByRole("region", { name: "Desktop environment" });
  const source = laptop
    .getByRole("link", { name: "Grace", exact: true })
    .element()
    .closest("li")!;
  const dataTransfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer }),
  );
  await expect.poll(() => source.dataset.dragging).toBe("true");
  const foreign = desktop
    .getByRole("button", { name: "Empty", exact: true })
    .element();
  foreign.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  const target = laptop
    .getByRole("button", { name: "Other", exact: true })
    .element();
  target.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await page.getByRole("button", { name: "Move agent", exact: true }).click();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/environments/laptop/proxy/api/agents/same-agent/move",
    expect.objectContaining({ method: "POST" }),
  );
});

it("keeps offline rosters visible and distinguishes identical team IDs", async () => {
  await using _screen = await render(
    <Sidebar
      sources={[
        rosters[0]!,
        { ...rosters[1]!, connected: false, error: "Unavailable" },
      ]}
    />,
  );
  const laptop = page.getByRole("region", { name: "Laptop environment" });
  await expect.element(laptop.getByRole("status")).toHaveTextContent("Offline");
  await expect
    .element(laptop.getByRole("link", { name: "Grace", exact: true }))
    .toBeVisible();
  await expect
    .element(laptop.getByRole("button", { name: "Create on Laptop" }))
    .toBeDisabled();
  expect(
    laptop
      .getByRole("link", { name: "Grace", exact: true })
      .element()
      .closest("li")!.draggable,
  ).toBe(false);
  expect(
    environmentDestination("laptop", {
      action: "new-agent",
      teamId: "same-team",
    }),
  ).toBe("/?environment=laptop&action=new-agent&team=same-team");
});
