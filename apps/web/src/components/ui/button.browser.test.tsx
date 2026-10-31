import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render.tsx";
import { Button } from "./button.tsx";

it.each(["light", "dark"])(
  "preserves button variant colors in %s mode despite global defaults",
  async (theme) => {
    const previousTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;

    try {
      await using _screen = await render(
        <>
          <Button>Primary action</Button>
          <Button variant="ghost">Neutral action</Button>
          <Button variant="destructive">Delete action</Button>
          <Button variant="outline">Outlined action</Button>
          <Button variant="secondary">Secondary action</Button>
        </>,
      );
      const primary = page.getByRole("button", { name: "Primary action" });
      const neutral = page.getByRole("button", { name: "Neutral action" });
      const destructive = page.getByRole("button", { name: "Delete action" });
      const outline = page.getByRole("button", { name: "Outlined action" });
      const secondary = page.getByRole("button", { name: "Secondary action" });
      const background = (element: Element) =>
        getComputedStyle(element).backgroundColor;
      const primaryBackground = background(primary.element());
      expect(getComputedStyle(primary.element()).color).toBe(
        "rgb(255, 255, 255)",
      );
      expect(background(neutral.element())).toBe("rgba(0, 0, 0, 0)");
      expect(background(destructive.element())).not.toBe(primaryBackground);
      expect(background(outline.element())).not.toBe(primaryBackground);
      expect(background(secondary.element())).not.toBe(primaryBackground);
      await neutral.hover();
      expect(background(neutral.element())).toBe("rgba(0, 0, 0, 0)");
      await primary.hover();
      const primaryHover = background(primary.element());
      await destructive.hover();
      expect(background(destructive.element())).not.toBe(primaryHover);
      expect(getComputedStyle(destructive.element()).color).toBe(
        "rgb(255, 255, 255)",
      );
    } finally {
      if (previousTheme === undefined)
        delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
    }
  },
);
