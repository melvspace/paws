import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ContextWindowMeter } from "./ContextWindowMeter.tsx";

it("shows real usage and invokes manual compaction", async () => {
  let compacted = false;
  await using _screen = await render(
    <ContextWindowMeter
      usage={{
        usedTokens: 196000,
        maxTokens: 258000,
        totalProcessedTokens: 900000,
      }}
      modelName="GPT-6-Astra"
      onCompact={() => {
        compacted = true;
      }}
    />,
  );
  await page.getByRole("button", { name: "76% context used" }).click();
  await expect
    .element(page.getByRole("progressbar", { name: "Context window usage" }))
    .toHaveAttribute("aria-valuenow", "76");
  await expect
    .element(page.getByText("76% · 196k/258k", { exact: true }))
    .toBeVisible();
  await page
    .getByRole("button", { name: "Compact context", exact: true })
    .click();
  expect(compacted).toBe(true);
});

it("does not invent usage and disables compaction while busy", async () => {
  await using _screen = await render(
    <ContextWindowMeter disabled compacting onCompact={() => {}} />,
  );
  await page.getByRole("button", { name: "Context usage unavailable" }).click();
  await expect
    .element(page.getByText("Not reported yet", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Compacting…" }))
    .toBeDisabled();
  await expect.element(page.getByRole("progressbar")).not.toBeInTheDocument();
});

it("uses an opaque themed surface and outlined button with production stylesheet order", async () => {
  const root = document.documentElement;
  const previous = root.dataset.theme;

  try {
    for (const [theme, color] of [
      ["dark", "rgb(17, 17, 17)"],
      ["light", "rgb(255, 255, 255)"],
    ]) {
      root.dataset.theme = theme;
      await using _screen = await render(
        <ContextWindowMeter onCompact={() => {}} />,
      );
      await page
        .getByRole("button", { name: "Context usage unavailable" })
        .click();
      await expect
        .element(page.getByText("Context Window", { exact: true }))
        .toBeVisible();
      const popup = document.querySelector(".context-window-popup")!;
      const button = popup.querySelector(".ui-button-outline")!;
      expect(getComputedStyle(popup).backgroundColor).toBe(color);
      expect(getComputedStyle(button).backgroundColor).toBe(color);
      expect(getComputedStyle(button).borderTopStyle).toBe("solid");
      expect(getComputedStyle(button).borderTopWidth).toBe("1px");
    }
  } finally {
    if (previous === undefined) delete root.dataset.theme;
    else root.dataset.theme = previous;
  }
});
