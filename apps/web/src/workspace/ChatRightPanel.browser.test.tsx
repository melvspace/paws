import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ChatRightPanel } from "./ChatRightPanel.tsx";

const bridge = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@paws/client-runtime", () => ({
  connectBrowser: () => {
    bridge.connect();

    return { send: () => true, close: bridge.close };
  },
}));

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [reveal, setReveal] = useState(0);

  return (
    <>
      <button onClick={() => setOpen(!open)}>Toggle sidebar</button>
      <button onClick={() => setReveal((value) => value + 1)}>
        Agent opens tab
      </button>
      <ChatRightPanel
        agentId="floating-test"
        open={open}
        browserOpen={browserOpen}
        browserReveal={reveal}
        maximized={false}
        sheet={false}
        rowWidth={1280}
        viewportWidth={1280}
        controls={null}
        onClose={() => setOpen(false)}
        onTabChange={() => setOpen(true)}
        onTabClose={async () => {
          setBrowserOpen(false);

          return true;
        }}
      >
        <p>Settings content</p>
      </ChatRightPanel>
    </>
  );
}

it("moves a live browser between sidebar and floating window without reconnecting", async () => {
  bridge.connect.mockClear();
  bridge.close.mockClear();
  await using _screen = await render(<Harness />);
  const address = page.getByRole("textbox", { name: "Browser address" });
  await expect.element(address).toBeVisible();
  const original = address.element();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect
    .element(
      page.getByRole("region", { name: "Floating browser", exact: true }),
    )
    .toBeVisible();
  await expect.element(original).not.toBeVisible();
  document.querySelector<HTMLElement>(".floating-browser-titlebar")!.focus();
  await page.getByRole("button", { name: "Dock browser in sidebar" }).click();
  await expect
    .element(
      page.getByRole("region", { name: "Floating browser", exact: true }),
    )
    .not.toBeInTheDocument();
  await expect.element(address).toBeVisible();
  expect(address.element()).toBe(original);
  expect(bridge.connect).toHaveBeenCalledTimes(1);
  expect(bridge.close).not.toHaveBeenCalled();
});

it("reveals agent browser activity in the open sidebar and lets a floating view stay dismissed", async () => {
  await using _screen = await render(<Harness initialOpen={false} />);
  await expect
    .element(
      page.getByRole("region", { name: "Floating browser", exact: true }),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("tab", { name: "Agent settings", exact: true }).click();
  await expect.element(page.getByText("Settings content")).toBeVisible();
  await page.getByRole("button", { name: "Agent opens tab" }).click();
  await expect
    .element(page.getByRole("tab", { name: "Browser", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText("Settings content")).not.toBeVisible();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  document.querySelector<HTMLElement>(".floating-browser-titlebar")!.focus();
  await page.getByRole("button", { name: "Close floating browser" }).click();
  await expect
    .element(
      page.getByRole("region", { name: "Floating browser", exact: true }),
    )
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect
    .element(page.getByRole("tab", { name: "Browser", exact: true }))
    .not.toBeInTheDocument();
});

it("drags the floating browser using its compact handle", async () => {
  await using _screen = await render(<Harness initialOpen={false} />);
  const floating = page.getByRole("region", {
    name: "Floating browser",
    exact: true,
  });
  const initial = floating.element().getBoundingClientRect();
  await userEvent.dragAndDrop(
    page.getByRole("group", { name: "Move floating browser" }),
    page.getByRole("button", { name: "Toggle sidebar" }),
    { sourcePosition: { x: 10, y: 12 } },
  );
  await expect
    .poll(() => floating.element().getBoundingClientRect().y)
    .not.toBe(initial.y);
});

it("restores per-agent size and position after resizing and reopening", async () => {
  const key = "paws.floating-browser.floating-test";
  localStorage.setItem(
    key,
    JSON.stringify({ x: 40, y: 50, width: 340, height: 300 }),
  );
  let saved: { x: number; y: number; width: number; height: number };

  {
    await using _screen = await render(<Harness initialOpen={false} />);
    const floating = page.getByRole("region", {
      name: "Floating browser",
      exact: true,
    });
    await expect
      .poll(() => floating.element().getBoundingClientRect().width)
      .toBe(340);
    expect(floating.element().getBoundingClientRect().x).toBe(40);
    expect(floating.element().getBoundingClientRect().y).toBe(50);
    const node = floating.element();
    // Native CSS resize changes inline dimensions; exercise its ResizeObserver.
    node.style.width = "360px";
    node.style.height = "340px";
    await expect
      .poll(() => JSON.parse(localStorage.getItem(key)!).width)
      .toBe(360);
    await expect
      .poll(() => JSON.parse(localStorage.getItem(key)!).height)
      .toBe(340);
    await userEvent.dragAndDrop(
      page.getByRole("group", { name: "Move floating browser" }),
      page.getByRole("button", { name: "Toggle sidebar" }),
      { sourcePosition: { x: 10, y: 12 } },
    );
    await expect
      .poll(() => JSON.parse(localStorage.getItem(key)!).x)
      .not.toBe(40);
    saved = JSON.parse(localStorage.getItem(key)!);
    expect(floating.element().getBoundingClientRect().x).toBe(saved.x);
    expect(floating.element().getBoundingClientRect().y).toBe(saved.y);
  }

  await using _screen = await render(<Harness initialOpen={false} />);
  const rect = page
    .getByRole("region", { name: "Floating browser", exact: true })
    .element()
    .getBoundingClientRect();
  expect({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }).toEqual(saved);
});

it("keeps restored floating windows on screen", async () => {
  localStorage.setItem(
    "paws.floating-browser.floating-test",
    JSON.stringify({
      x: 10000,
      y: 10000,
      width: 4000,
      height: 3000,
    }),
  );
  await using _screen = await render(<Harness initialOpen={false} />);
  const rect = page
    .getByRole("region", { name: "Floating browser", exact: true })
    .element()
    .getBoundingClientRect();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
});
