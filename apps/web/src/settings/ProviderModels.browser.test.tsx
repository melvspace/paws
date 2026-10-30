import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { codexFixture, modelFixtures } from "../../test/providerFixtures.ts";
import { ProviderModels } from "./ProviderModels.tsx";
import { ModelPicker } from "../workspace/ModelPicker.tsx";

afterEach(() => localStorage.clear());

it("syncs model visibility and favorites between settings and the mounted picker", async () => {
  await using _screen = await render(
    <div className="providers-settings">
      <ProviderModels provider={codexFixture} />
      <ModelPicker
        models={modelFixtures}
        value="codex:gpt-6-astra"
        onChange={() => {}}
      />
    </div>,
  );
  await page
    .getByRole("switch", { name: "Show GPT-6.1-Sol in picker" })
    .click();
  await page.getByRole("button", { name: "Choose model: GPT-6-Astra" }).click();
  await expect
    .element(page.getByRole("option"))
    .toHaveTextContent("GPT-6-AstraCodexCtrl+1");
  await userEvent.keyboard("{Escape}");
  await page
    .getByRole("button", { name: "Add GPT-6-Astra to favorites" })
    .click();
  await page.getByRole("button", { name: "Choose model: GPT-6-Astra" }).click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect
    .element(page.getByRole("option"))
    .toHaveTextContent("GPT-6-AstraCodexCtrl+1");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Disable all", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Enable all", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Enable all", exact: true }).click();
  await expect
    .element(page.getByRole("switch", { name: "Show GPT-6.1-Sol in picker" }))
    .toBeChecked();
});
