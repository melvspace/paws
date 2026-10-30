import { useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { modelFixtures } from "../../test/providerFixtures.ts";
import { favoritesStorageKey } from "./models.ts";

function Picker() {
  const [model, setModel] = useState("codex:gpt-6-astra");

  return (
    <ModelPicker models={modelFixtures} value={model} onChange={setModel} />
  );
}

afterEach(() => localStorage.removeItem(favoritesStorageKey));

it("searches, selects with the keyboard, and restores focus", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model: GPT-6-Astra" }).click();
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect.element(search).toHaveFocus();
  await search.fill("sol");
  await expect
    .element(page.getByRole("option"))
    .toHaveTextContent("GPT-6.1-SolCodexCtrl+1");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  const trigger = page.getByRole("button", {
    name: "Choose model: GPT-6.1-Sol",
  });
  await expect.element(trigger).toBeVisible();
  await expect.element(trigger).toHaveFocus();
  await expect.element(search).not.toBeInTheDocument();
});

it("favorites do not select or dismiss; provider tab and search expose unfavorited models", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model: GPT-6-Astra" }).click();
  await page
    .getByRole("button", { name: "Favorite GPT-6.1-Sol", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Favorite GPT-6-Astra", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await page
    .getByRole("button", { name: "Unfavorite GPT-6.1-Sol", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Unfavorite GPT-6-Astra", exact: true })
    .click();
  await expect.element(page.getByText("No favorites yet")).toBeVisible();
  expect(localStorage.getItem(favoritesStorageKey)).toBe("[]");
  await page.getByRole("button", { name: "Codex models" }).click();
  await expect
    .element(page.getByRole("option", { name: /GPT-6.1-Sol/ }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
});

it("opens with Ctrl+Shift+M and picks a visible model with Ctrl+1", async () => {
  await using _screen = await render(<Picker />);
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  await expect.element(page.getByRole("combobox")).toBeVisible();
  await userEvent.keyboard("{Control>}1{/Control}");
  await expect
    .element(page.getByRole("button", { name: "Choose model: GPT-6.1-Sol" }))
    .toBeVisible();
  await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
});
