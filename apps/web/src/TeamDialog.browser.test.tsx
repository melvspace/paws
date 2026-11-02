import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { TeamDialog } from "./TeamDialog.tsx";

afterEach(() => vi.restoreAllMocks());

it("retains a failed draft and closes after a successful retry", async () => {
  const team = {
    id: "project",
    name: "Project",
    memory: "",
    template: "paws-team-runtime:1",
    createdAt: "2026-11-02",
  };
  const request = vi
    .spyOn(window, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValueOnce(Response.json(team));
  const onDismiss = vi.fn();
  const onCreated = vi.fn();
  await using _screen = await render(
    <TeamDialog connected onDismiss={onDismiss} onCreated={onCreated} />,
  );
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Project");
  await expect
    .element(page.getByRole("textbox", { name: "Container template" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(name).toHaveValue("Project");
  expect(onDismiss).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect.poll(() => onDismiss.mock.calls.length).toBe(1);
  expect(onCreated).toHaveBeenCalledWith(team);
  expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
    name: "Project",
    memory: "",
  });
});

it("keeps pending creation open and prevents duplicate submissions", async () => {
  let finish!: (response: Response) => void;
  const request = vi.spyOn(window, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const onDismiss = vi.fn();
  await using _screen = await render(
    <TeamDialog connected onDismiss={onDismiss} />,
  );
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Project");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Creating…" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Cancel", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Close dialog" }))
    .toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();
  finish(new Response(null, { status: 500 }));
  await expect.element(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(onDismiss).toHaveBeenCalledOnce();
});
