import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ReasoningPicker } from "./ReasoningPicker.tsx";
import { codexFixture } from "../../test/providerFixtures.ts";

function Picker() {
  const [options, setOptions] = useState<Record<string, string>>({
    reasoningEffort: "medium",
    serviceTier: "default",
  });

  return (
    <ReasoningPicker
      model={codexFixture.models[1]}
      value={options}
      onChange={setOptions}
    />
  );
}

it("selects reasoning with the keyboard and restores focus; Escape preserves the choice", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Reasoning: Medium" }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Medium Default" }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("menu")).toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Low", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Medium Default" }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "High", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const trigger = page.getByRole("button", { name: "Reasoning: High" });
  await expect.element(trigger).toHaveFocus();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await trigger.click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "High", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Ultra" }).click();
  await page.getByRole("button", { name: "Reasoning: Ultra" }).click();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Reasoning: Ultra" }))
    .toHaveFocus();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
});

it("switches service tier independently of reasoning", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Reasoning: Medium" }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Standard Default" }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Fast", exact: true }).click();
  await page.getByRole("button", { name: "Reasoning: Medium, Fast" }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Fast", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Medium Default" }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Standard Default" }).click();
  await expect
    .element(
      page.getByRole("button", { name: "Reasoning: Medium", exact: true }),
    )
    .toHaveFocus();
});

it("only shows the selected model's options, including models without reasoning", async () => {
  function ChangingPicker() {
    const [tierOnly, setTierOnly] = useState(false);
    const [options, setOptions] = useState<Record<string, string>>({
      reasoningEffort: "ultra",
      serviceTier: "fast",
    });
    const reference = codexFixture.models[1]!;
    const model = tierOnly
      ? { ...reference, options: [reference.options[0]!] }
      : reference;

    return (
      <>
        <button onClick={() => setTierOnly(true)}>Change model</button>
        <ReasoningPicker model={model} value={options} onChange={setOptions} />
      </>
    );
  }

  await using _screen = await render(<ChangingPicker />);
  await page.getByRole("button", { name: "Change model" }).click();
  await page
    .getByRole("button", { name: "Reasoning: Ultra", exact: true })
    .click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Fast", exact: true }))
    .not.toBeInTheDocument();
});
