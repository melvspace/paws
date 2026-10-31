import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ChatImage } from "./ChatImage.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=";

it("opens images with the keyboard, loads the preview, and restores focus on Escape", async () => {
  await using _screen = await render(<ChatImage src={image} alt="A cat" />);
  const trigger = page.getByRole("button", { name: "Preview A cat" });
  trigger.element().focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "A cat" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByRole("img", { name: "A cat" }))
    .toHaveAttribute("data-ready", "true");
  await expect.element(dialog.getByRole("status")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  await trigger.click();
  await expect
    .element(dialog.getByRole("img", { name: "A cat" }))
    .toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Close image preview" }).click();
  await expect.element(trigger).toHaveFocus();
});

it("opens linked Markdown images in the preview instead of navigating", async () => {
  await using _screen = await render(
    <MessageMarkdown text="[![A linked cat](https://example.com/cat.png)](https://example.com/original)" />,
  );
  expect(document.querySelector("a .chat-image-trigger")).toBeNull();
  await page.getByRole("button", { name: "Preview A linked cat" }).click();
  const dialog = page.getByRole("dialog", { name: "A linked cat" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(
      dialog.getByRole("img", { name: "A linked cat", includeHidden: true }),
    )
    .toHaveAttribute("src", "https://example.com/cat.png");
  await userEvent.keyboard("{Escape}");
});

it("shows a useful error when the full image cannot load", async () => {
  await using _screen = await render(
    <ChatImage src="data:image/png;base64,invalid" alt="Missing image" />,
  );
  await page.getByRole("button", { name: "Preview Missing image" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("This image could not be loaded.");
  await page.getByRole("button", { name: "Close image preview" }).click();
});
