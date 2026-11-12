import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { providersAtom } from "@paws/client-runtime";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { render } from "../../test/render.tsx";
import { codexFixture } from "../../test/providerFixtures.ts";
import { AppSettingsDialog } from "./AppSettingsDialog.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  appAtomRegistry.set(providersAtom, { providers: [], error: null });
});

it("retains failed selections, retries immediately and waits for autosave before closing", async () => {
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  const state = { selection: null, effectiveSelection: null, errors: [] };
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockResolvedValueOnce(Response.json(state))
    .mockResolvedValueOnce(new Response(null, { status: 400 }));
  let complete = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () =>
          resolve(
            Response.json({
              ...state,
              selection: {
                providerId: "codex",
                modelId: "gpt-6.1-sol",
                options: {},
              },
            }),
          );
      }),
  );
  const dismiss = vi.fn();
  await using _screen = await render(
    <AppSettingsDialog initialPage="Chat" onDismiss={dismiss} />,
  );
  const picker = page.getByRole("combobox", { name: "Text generation model" });
  await expect.element(picker).toBeEnabled();
  await picker.selectOptions("codex:gpt-6.1-sol");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(picker).toHaveValue("codex:gpt-6.1-sol");
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(dismiss).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(dismiss).not.toHaveBeenCalled();
  complete();
  await expect.poll(() => dismiss.mock.calls.length).toBe(1);
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    selection: { providerId: "codex", modelId: "gpt-6.1-sol", options: {} },
  });
});
