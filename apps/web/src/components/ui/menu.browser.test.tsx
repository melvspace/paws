import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render.tsx";
import { Button } from "./button.tsx";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
} from "./menu.tsx";

it("styles plain menu items by default and preserves keyboard navigation and disabled actions", async () => {
  const rename = vi.fn();
  const share = vi.fn();
  const unavailable = vi.fn();
  await using _screen = await render(
    <Menu>
      <MenuTrigger render={<Button />}>Machine actions</MenuTrigger>
      <MenuPopup aria-label="Machine actions" side="bottom">
        <MenuItem onClick={rename}>Rename</MenuItem>
        <MenuItem disabled onClick={unavailable}>
          Unavailable
        </MenuItem>
        <MenuItem onClick={share}>Sharing &amp; access</MenuItem>
      </MenuPopup>
    </Menu>,
  );
  const trigger = page.getByRole("button", {
    name: "Machine actions",
    exact: true,
  });
  trigger.element().focus();
  await userEvent.keyboard("{Enter}");
  const first = page.getByRole("menuitem", { name: "Rename", exact: true });
  await expect.element(first).toHaveFocus();
  const styles = getComputedStyle(first.element());
  expect(Number.parseFloat(styles.paddingLeft)).toBeGreaterThan(0);
  expect(Number.parseFloat(styles.paddingTop)).toBeGreaterThan(0);
  expect(
    page.getByRole("menu").element().getBoundingClientRect().width,
  ).toBeLessThan(240);
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("menuitem", { name: "Unavailable", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(unavailable).not.toHaveBeenCalled();
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(
      page.getByRole("menuitem", { name: "Sharing & access", exact: true }),
    )
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(share).toHaveBeenCalledOnce();
  expect(rename).not.toHaveBeenCalled();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("keeps styled radio groups, labels, separators and caller classes usable without styling props", async () => {
  const change = vi.fn();
  await using _screen = await render(
    <Menu>
      <MenuTrigger render={<Button />}>Preferences</MenuTrigger>
      <MenuPopup aria-label="Preferences" className="custom-menu">
        <MenuGroup>
          <MenuGroupLabel>Follow-ups</MenuGroupLabel>
          <MenuRadioGroup defaultValue="queue" onValueChange={change}>
            <MenuRadioItem value="queue" closeOnClick>
              Queue
            </MenuRadioItem>
            <MenuRadioItem
              value="steer"
              className={(state) =>
                state.highlighted ? "custom-highlight" : "custom-item"
              }
              closeOnClick
            >
              Steer
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem variant="destructive">Forget</MenuItem>
      </MenuPopup>
    </Menu>,
  );
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect.element(page.getByRole("menu")).toHaveClass("custom-menu");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Queue", exact: true }))
    .toBeChecked();
  const steer = page.getByRole("menuitemradio", { name: "Steer", exact: true });
  await steer.hover();
  await expect.element(steer).toHaveClass("custom-highlight");
  expect(
    Number.parseFloat(getComputedStyle(steer.element()).paddingLeft),
  ).toBeGreaterThan(0);
  await steer.click();
  expect(change).toHaveBeenCalledWith("steer", expect.anything());
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
});
