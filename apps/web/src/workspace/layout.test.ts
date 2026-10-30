import { expect, it } from "vite-plus/test";
import { clampPanelSize, panelMaxWidth, terminalMaxHeight } from "./layout.ts";

it("keeps a 360px chat column while limiting the right panel to 70% of the viewport", () => {
  expect(panelMaxWidth(1400, 1100)).toBe(740);
  expect(panelMaxWidth(1000, 1000)).toBe(640);
  expect(panelMaxWidth(2000, 2000)).toBe(1400);
  expect(panelMaxWidth(500, 500)).toBe(360);
});

it("reserves the header and composer when clamping terminal height", () => {
  expect(terminalMaxHeight(1000, 800)).toBe(568);
  expect(terminalMaxHeight(800, 1000)).toBe(600);
  expect(clampPanelSize(240, 180, terminalMaxHeight(200, 200))).toBe(0);
});
