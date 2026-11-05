import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";
import {
  environmentFetch,
  environmentPath,
  environmentSocketUrl,
} from "@paws/client-runtime";

const initial = {
  local: { id: "desktop", name: "Desktop", platform: "linux" },
  sharing: false,
  port: 4312,
  addresses: ["http://192.168.1.5:4312"],
  linked: [],
  connections: [],
  discoveryError: null,
};
const peer = {
  id: "laptop",
  name: "Laptop",
  platform: "linux",
  url: "http://100.64.0.1:4312",
  source: "tailscale",
};

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", location.pathname);
});

it("discovers and links machines, autosaves sharing, and displays pairing codes", async () => {
  let state = initial;
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/discover"))
        return Response.json({ environments: [peer], warnings: [] });
      if (url.endsWith("/pairing"))
        return Response.json({
          code: "private-pairing-code",
          expiresAt: "2026-11-05T14:00:00Z",
        });
      if (url.endsWith("/link"))
        return Response.json({ ...state, linked: [peer] });
      if (options?.method === "PATCH")
        state = { ...state, ...JSON.parse(String(options.body)) };

      return Response.json(state);
    });
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Environments" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("heading", { name: "Connections", exact: true }))
    .toBeVisible();
  await page
    .getByRole("button", { name: "Sharing & access", exact: true })
    .click();
  await page
    .getByRole("switch", { name: "Share on LAN and Tailscale" })
    .click();
  await page.getByRole("button", { name: "Create pairing code" }).click();
  await expect
    .element(
      page.getByRole("textbox", { name: "Pairing code for this computer" }),
    )
    .toHaveValue("private-pairing-code");
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Add environment", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Pair with Laptop" }).click();
  const addDialog = page.getByRole("dialog", {
    name: "Add environment",
    exact: true,
  });
  await expect
    .element(addDialog.getByRole("button", { name: "Discover", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(addDialog.getByLabelText("Pairing code from other computer"))
    .toHaveFocus();
  await expect
    .element(page.getByRole("textbox", { name: "Environment address" }))
    .toHaveValue(peer.url);
  await page
    .getByLabelText("Pairing code from other computer")
    .fill("other-computer-code");
  await page
    .getByRole("button", { name: "Link environment", exact: true })
    .click();
  await page.getByRole("button", { name: "More options for Laptop" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Forget Laptop" }))
    .toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/environments/link",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        url: peer.url,
        code: "other-computer-code",
        expectedId: peer.id,
      }),
    }),
  );
});

it("flushes names before dismissal and keeps failed edits visible", async () => {
  const dismiss = vi.fn();
  const fetchMock = vi
    .fn()
    .mockImplementation(async (_url: string, options?: RequestInit) =>
      options?.method === "PATCH"
        ? Response.json(
            { error: "Name could not be saved. Retry." },
            { status: 400 },
          )
        : Response.json(initial),
    );
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Environments" onDismiss={dismiss} />,
  );
  await page.getByRole("button", { name: "More options for Desktop" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Environment name" })
    .fill("New name");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Name could not be saved. Retry.");
  expect(dismiss).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("textbox", { name: "Environment name" }))
    .toHaveValue("New name");
});

it("keeps remote requests, streams and attachments same-origin while managing links locally", async () => {
  history.replaceState(null, "", "?environment=laptop");
  const fetchMock = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ ...initial, linked: [peer] }),
    );
  vi.stubGlobal("fetch", fetchMock);
  expect(environmentPath("/api/agents/a/chat/attachments/b")).toBe(
    "/api/environments/laptop/proxy/api/agents/a/chat/attachments/b",
  );
  expect(environmentSocketUrl("/ws")).toBe(
    `${location.origin.replace("http:", "ws:")}/api/environments/laptop/proxy/ws`,
  );
  await environmentFetch("/api/agents");
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/environments/laptop/proxy/api/agents",
    undefined,
  );
});

it("keeps workspace drafts and uploaded attachment references separate between environments", async () => {
  const { readWorkspace, writeWorkspace } =
    await import("../workspace/state.ts");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const local = readWorkspace(storage, "same-agent");
  writeWorkspace(storage, "same-agent", { ...local, draft: "Local draft" });
  history.replaceState(null, "", "?environment=laptop");
  expect(readWorkspace(storage, "same-agent").draft).toBe("");
  writeWorkspace(storage, "same-agent", { ...local, draft: "Laptop draft" });
  history.replaceState(null, "", "?environment=desktop");
  expect(readWorkspace(storage, "same-agent").draft).toBe("");
  history.replaceState(null, "", "?environment=laptop");
  expect(readWorkspace(storage, "same-agent").draft).toBe("Laptop draft");
  history.replaceState(null, "", location.pathname);
  expect(readWorkspace(storage, "same-agent").draft).toBe("Local draft");
});

it("pauses and resumes connections with switches and keeps failed changes visible", async () => {
  let enabled = true;
  let fail = false;
  const fetchMock = vi
    .fn()
    .mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        if (fail)
          return Response.json(
            { error: "Could not change this connection. Retry." },
            { status: 400 },
          );

        enabled = JSON.parse(String(options.body)).enabled;
      }

      return Response.json({ ...initial, linked: [{ ...peer, enabled }] });
    });
  vi.stubGlobal("fetch", fetchMock);
  await using _screen = await render(
    <AppSettingsDialog initialPage="Environments" onDismiss={() => {}} />,
  );
  const toggle = page.getByRole("switch", { name: "Enable Laptop" });
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/environments/links/laptop",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    }),
  );
  fail = true;
  await toggle.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not change this connection. Retry.");
  await expect.element(toggle).not.toBeChecked();
});

it("keeps sharing controls out of the machine list and shows approved computers only in Sharing & access", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () =>
      Response.json({
        ...initial,
        connections: [{ id: "phone", name: "Phone", platform: "android" }],
      }),
    ),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Environments" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("button", { name: "Add environment", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: "Share on LAN and Tailscale" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("textbox", { name: "Environment address" }))
    .not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "Sharing & access", exact: true })
    .click();
  await expect
    .element(page.getByRole("switch", { name: "Share on LAN and Tailscale" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Revoke Phone", exact: true }))
    .toBeVisible();
});

it("opens Rename as a focused dialog and waits for one pending save before closing", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetchMock = vi
    .fn()
    .mockImplementation(async (_url: string, options?: RequestInit) =>
      options?.method === "PATCH" ? pending : Response.json(initial),
    );
  vi.stubGlobal("fetch", fetchMock);
  const dismissSettings = vi.fn();

  try {
    await using _screen = await render(
      <AppSettingsDialog
        initialPage="Environments"
        onDismiss={dismissSettings}
      />,
    );
    await page
      .getByRole("button", { name: "More options for Desktop" })
      .click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Rename environment",
      exact: true,
    });
    const input = dialog.getByRole("textbox", { name: "Environment name" });
    await expect.element(input).toHaveFocus();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await input.fill("Workstation");
    await dialog
      .getByRole("button", { name: "Close rename environment" })
      .click();
    await expect
      .poll(
        () =>
          fetchMock.mock.calls.filter(
            ([, options]) => options?.method === "PATCH",
          ).length,
      )
      .toBe(1);
    await expect.element(dialog).toBeVisible();
    expect(dismissSettings).not.toHaveBeenCalled();
    resolve(
      Response.json({
        ...initial,
        local: { ...initial.local, name: "Workstation" },
      }),
    );
    await expect.element(dialog).not.toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "More options for Workstation" }),
      )
      .toHaveFocus();
    await expect
      .element(page.getByRole("navigation", { name: "Settings pages" }))
      .toBeVisible();
  } finally {
    resolve(Response.json(initial));
  }
});

it("retains failed pairing inputs, protects a pending link, and returns focus after cancellation", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.endsWith("/link") ? pending : Response.json(initial),
    );
  vi.stubGlobal("fetch", fetchMock);
  const dismissSettings = vi.fn();

  try {
    await using _screen = await render(
      <AppSettingsDialog
        initialPage="Environments"
        onDismiss={dismissSettings}
      />,
    );
    const trigger = page.getByRole("button", {
      name: "Add environment",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Add environment",
      exact: true,
    });
    const address = dialog.getByRole("textbox", {
      name: "Environment address",
    });
    await expect.element(address).toHaveFocus();
    await address.fill(peer.url);
    await dialog
      .getByLabelText("Pairing code from other computer")
      .fill("retry-code");
    await dialog
      .getByRole("button", { name: "Link environment", exact: true })
      .click();
    await expect
      .element(dialog.getByRole("button", { name: "Cancel", exact: true }))
      .toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).toBeVisible();
    expect(dismissSettings).not.toHaveBeenCalled();
    resolve(
      Response.json(
        { error: "Pairing failed. Create a new code and retry." },
        { status: 400 },
      ),
    );
    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("Pairing failed. Create a new code and retry.");
    await expect.element(address).toHaveValue(peer.url);
    await expect
      .element(dialog.getByLabelText("Pairing code from other computer"))
      .toHaveValue("retry-code");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await expect
      .element(page.getByRole("navigation", { name: "Settings pages" }))
      .toBeVisible();
  } finally {
    resolve(Response.json(initial));
  }
});

it("restores focus to the discovered machine and keeps manual addition separate", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        Response.json(
          url.endsWith("/discover")
            ? { environments: [peer], warnings: [] }
            : initial,
        ),
      ),
  );
  await using _screen = await render(
    <AppSettingsDialog initialPage="Environments" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const pair = page.getByRole("button", { name: "Pair with Laptop" });
  await pair.click();
  const dialog = page.getByRole("dialog", {
    name: "Add environment",
    exact: true,
  });
  await expect
    .element(dialog.getByLabelText("Pairing code from other computer"))
    .toHaveFocus();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(pair).toHaveFocus();
  await page
    .getByRole("button", { name: "Add environment", exact: true })
    .click();
  await expect
    .element(dialog.getByRole("textbox", { name: "Environment address" }))
    .toHaveValue("");
  await expect
    .element(dialog.getByRole("textbox", { name: "Environment address" }))
    .toHaveFocus();
  await expect
    .element(dialog.getByRole("button", { name: "Discover", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(
      dialog.getByRole("heading", { name: "Nearby environments", exact: true }),
    )
    .not.toBeInTheDocument();
});
