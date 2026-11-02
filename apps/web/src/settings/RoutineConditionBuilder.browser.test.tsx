import { useState } from "react";
import type { RoutineFilterGroup } from "@paws/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { RoutineConditionBuilder } from "./RoutineConditionBuilder.tsx";
import "./routines.css";

function expectControlsFit() {
  const form = page.getByRole("form").element();
  const bounds = form.getBoundingClientRect();

  for (const control of form.querySelectorAll(
    'input:not([aria-hidden="true"]), button',
  )) {
    const box = control.getBoundingClientRect();

    if (box.width === 0) continue;

    expect(box.left).toBeGreaterThanOrEqual(bounds.left);
    expect(box.right).toBeLessThanOrEqual(bounds.right);
  }
}

it.each([260, 450])(
  "edits webhook conditions without losing values or overflowing a %ipx panel",
  async (width) => {
    const changed = vi.fn();
    const committed = vi.fn();

    function Editor() {
      const [filters, setFilters] = useState<RoutineFilterGroup>({
        combinator: "and",
        rules: [
          { path: "repo", operator: "equals", value: "paws" },
          { path: "branch", operator: "equals", value: "main" },
        ],
      });

      return (
        <div className="routines-settings" style={{ width }}>
          <RoutineConditionBuilder
            filters={filters}
            onChange={(next) => {
              changed(next);
              setFilters(next);
            }}
            onCommit={committed}
          />
        </div>
      );
    }

    await page.viewport(width + 64, 700);
    await using _screen = await render(<Editor />);
    expectControlsFit();

    expect(
      page.getByRole("button", { name: "Add group", exact: true }).elements(),
    ).toHaveLength(1);
    await page
      .getByRole("textbox", { name: "Field", exact: true })
      .first()
      .fill("repository.name");
    await expect
      .element(
        page.getByRole("textbox", { name: "Value", exact: true }).first(),
      )
      .toHaveValue("paws");
    const condition = page
      .getByRole("combobox", { name: "Condition", exact: true })
      .first();
    await condition.click();
    await page.getByRole("option", { name: "exists", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Value", exact: true }))
      .toHaveValue("main");
    expect(changed).toHaveBeenLastCalledWith({
      combinator: "and",
      rules: [
        { path: "repository.name", operator: "exists", value: "paws" },
        { path: "branch", operator: "equals", value: "main" },
      ],
    });
    expect(committed).toHaveBeenCalled();

    await condition.click();
    await page.getByRole("option", { name: "is one of", exact: true }).click();
    const values = page.getByRole("textbox", {
      name: "Values, comma-separated",
      exact: true,
    });
    await expect.element(values).toHaveValue("paws");
    await values.fill("paws, t3");
    await page
      .getByRole("button", { name: "Remove filter 2", exact: true })
      .click();
    expect(changed).toHaveBeenLastCalledWith({
      combinator: "and",
      rules: [{ path: "repository.name", operator: "in", value: "paws, t3" }],
    });

    await page
      .getByRole("button", { name: "Remove filter 1", exact: true })
      .click();
    expect(changed).toHaveBeenLastCalledWith({ combinator: "and", rules: [] });
    await page.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Field", exact: true }))
      .toHaveValue("");
    await expect
      .element(page.getByRole("textbox", { name: "Value", exact: true }))
      .toHaveValue("");
    expect(changed).toHaveBeenLastCalledWith({
      combinator: "and",
      rules: [{ path: "", operator: "equals", value: "" }],
    });
  },
);

it.each([260, 450])(
  "edits nested AND/OR groups within a %ipx panel and removes a group without affecting its siblings",
  async (width) => {
    const changed = vi.fn();
    const committed = vi.fn();

    function Editor() {
      const [filters, setFilters] = useState<RoutineFilterGroup>({
        combinator: "and",
        rules: [{ path: "repo", operator: "equals", value: "paws" }],
      });

      return (
        <div className="routines-settings" style={{ width }}>
          <RoutineConditionBuilder
            filters={filters}
            onChange={(next) => {
              changed(next);
              setFilters(next);
            }}
            onCommit={committed}
          />
        </div>
      );
    }

    await page.viewport(width + 64, 900);
    await using _screen = await render(<Editor />);
    await page.getByRole("button", { name: "Add group", exact: true }).click();
    await page.getByRole("button", { name: "OR", exact: true }).last().click();
    await page
      .getByRole("button", { name: "Add filter", exact: true })
      .last()
      .click();
    await page
      .getByRole("textbox", { name: "Field", exact: true })
      .last()
      .fill("branch");
    await page
      .getByRole("textbox", { name: "Value", exact: true })
      .last()
      .fill("main");
    await page
      .getByRole("button", { name: "Add group", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Add filter", exact: true })
      .last()
      .click();
    await page
      .getByRole("textbox", { name: "Field", exact: true })
      .last()
      .fill("release");
    await page
      .getByRole("combobox", { name: "Condition", exact: true })
      .last()
      .click();
    await page.getByRole("option", { name: "exists", exact: true }).click();
    await page.getByRole("button", { name: "OR", exact: true }).first().click();
    expect(changed).toHaveBeenLastCalledWith({
      combinator: "or",
      rules: [
        { path: "repo", operator: "equals", value: "paws" },
        {
          combinator: "or",
          rules: [
            { path: "branch", operator: "equals", value: "main" },
            {
              combinator: "and",
              rules: [{ path: "release", operator: "exists", value: "" }],
            },
          ],
        },
      ],
    });
    expect(committed).toHaveBeenCalled();
    expectControlsFit();

    await page
      .getByRole("button", { name: "Remove group 2", exact: true })
      .click();
    expect(changed).toHaveBeenLastCalledWith({
      combinator: "or",
      rules: [{ path: "repo", operator: "equals", value: "paws" }],
    });
  },
);
