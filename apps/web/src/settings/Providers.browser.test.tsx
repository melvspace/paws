import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { ProviderSnapshot } from "@paws/contracts";
import { render } from "../../test/render.tsx";
import { codexFixture } from "../../test/providerFixtures.ts";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";
import { providersAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "../lib/atomRegistry.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  appAtomRegistry.set(providersAtom, { providers: [], error: null });
});

function mockProviders() {
  let providers: ProviderSnapshot[] = [
    codexFixture,
    {
      ...codexFixture,
      config: {
        ...codexFixture.config,
        id: "claude",
        driver: "claudeAgent",
        name: "Claude",
        enabled: false,
      },
      models: [],
      status: "disabled",
      auth: "unknown",
    },
  ];
  const requests: {
    url: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url, method, body });

      if (method === "GET") return Response.json({ providers });

      if (method === "POST" && url === "/api/providers") {
        const provider: ProviderSnapshot = {
          ...codexFixture,
          config: {
            ...codexFixture.config,
            id: "added-grok",
            driver: "grok",
            name: "Grok",
          },
          auth: "unknown",
          status: "unchecked",
          version: null,
          models: [],
        };
        providers.push(provider);

        return Response.json(provider);
      }

      const id = url.split("/")[3]!;
      let provider = providers.find((item) => item.config.id === id)!;

      if (method === "DELETE") {
        providers = providers.filter((item) => item.config.id !== id);

        return Response.json({ removed: true });
      }

      if (url.endsWith("/environment"))
        provider = { ...provider, environment: [String(body.name)] };
      else if (url.endsWith("/refresh"))
        provider = {
          ...provider,
          status: id === "added-grok" ? "missing" : "ready",
          models:
            id === "added-grok"
              ? []
              : [{ id: "claude-test", name: "Claude Test", options: [] }],
        };
      else provider = { ...provider, config: { ...provider.config, ...body } };
      providers = providers.map((item) =>
        item.config.id === id ? provider : item,
      );

      return Response.json(provider);
    }),
  );

  return requests;
}

it("uses a provider list/details layout, saves on blur, enables and refreshes a provider", async () => {
  const requests = mockProviders();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Providers" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("textbox", { name: "Display name", exact: true }))
    .toHaveValue("Codex");
  await page
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Personal Codex");
  await page.getByRole("heading", { name: "Status", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Personal Codex", exact: true }))
    .toBeVisible();
  expect(
    requests.some(
      (request) =>
        request.method === "PATCH" && request.body.name === "Personal Codex",
    ),
  ).toBe(true);
  const navigation = page.getByRole("navigation", {
    name: "Configured providers",
  });
  await navigation.getByRole("button", { name: /Claude/ }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Display name", exact: true }))
    .toHaveValue("Claude");
  await page.getByRole("switch", { name: "Enable Claude" }).click();
  await expect
    .element(page.getByText("Claude Test", { exact: true }))
    .toBeVisible();
  expect(
    requests.some((request) => request.url.endsWith("/claude/refresh")),
  ).toBe(true);
});

it("keeps secret values write-only without provider removal controls", async () => {
  const requests = mockProviders();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Providers" onDismiss={() => {}} />,
  );
  await page.getByRole("button", { name: "Add variable" }).click();
  await page
    .getByRole("textbox", { name: "Variable name" })
    .fill("OPENAI_API_KEY");
  await page.getByLabelText("Variable value").fill("fake-secret-test-only");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .element(page.getByText("OPENAI_API_KEY", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Variable value"))
    .not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("fake-secret-test-only");
  expect(
    requests.some((request) => request.body.value === "fake-secret-test-only"),
  ).toBe(true);
  await expect
    .element(page.getByRole("button", { name: "Remove", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Sign in", exact: true }))
    .not.toBeInTheDocument();
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
});

it("shows Agents navigation and relative check time with no setup actions for authenticated providers", async () => {
  mockProviders();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Providers" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("heading", { name: "Agents", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Codex");
  appAtomRegistry.set(providersAtom, {
    providers: [
      {
        ...codexFixture,
        checkedAt: new Date(Date.now() - 210_000).toISOString(),
      },
    ],
    error: null,
  });
  await expect
    .element(page.getByRole("button", { name: "Refresh provider status" }))
    .toHaveTextContent("Checked 3m ago");
  await expect
    .element(page.getByRole("button", { name: "Sign in", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("link", { name: "Setup guide" }))
    .not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("codex login");
  expect(document.querySelector(".provider-card-footer")).toBeNull();
});

it("adds an absent provider for setup with consistent link-button styling", async () => {
  const requests = mockProviders();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Providers" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Codex");
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("menuitem", { name: "Grok", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Grok");
  await expect
    .element(page.getByRole("link", { name: "Setup guide" }))
    .toBeVisible();
  expect(
    requests.some((request) => request.url.endsWith("/added-grok/refresh")),
  ).toBe(true);
  const guide = document.querySelector<HTMLAnchorElement>(
    ".provider-details a.ui-button",
  )!;
  const styles = getComputedStyle(guide);
  // Flex items blockify inline-flex; both links and buttons must retain flex layout.
  expect(styles.display).toBe("flex");
  expect(styles.borderRadius).toBe("6px");
  expect(guide.getBoundingClientRect().right).toBeLessThanOrEqual(
    guide.closest(".provider-panel")!.getBoundingClientRect().right,
  );
});

it("blurs account emails until explicitly revealed and conceals changed accounts", async () => {
  mockProviders();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Providers" onDismiss={() => {}} />,
  );
  await expect
    .element(page.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Codex");
  const showAccount = (email: string) =>
    appAtomRegistry.set(providersAtom, {
      providers: [
        {
          ...codexFixture,
          account: { email, label: "ChatGPT Pro 100 Subscription" },
        },
      ],
      error: null,
    });
  showAccount("test@example.com");
  const reveal = page.getByRole("button", {
    name: "Click to reveal email",
    exact: true,
  });
  await expect.element(reveal).toHaveAttribute("aria-pressed", "false");
  const text = document.querySelector(".sensitive-text > span")!;
  expect(getComputedStyle(text).filter).toBe("blur(5px)");
  expect(text.getAttribute("aria-hidden")).toBe("true");
  await reveal.click();
  await expect
    .element(
      page.getByRole("button", {
        name: "test@example.com. Click to hide email",
        exact: true,
      }),
    )
    .toHaveAttribute("aria-pressed", "true");
  expect(getComputedStyle(text).filter).toBe("none");
  await userEvent.keyboard("{Enter}");
  await expect.element(reveal).toHaveAttribute("aria-pressed", "false");
  await reveal.click();
  showAccount("other@example.com");
  await expect.element(reveal).toHaveAttribute("aria-pressed", "false");
  expect(
    getComputedStyle(document.querySelector(".sensitive-text > span")!).filter,
  ).toBe("blur(5px)");
});
