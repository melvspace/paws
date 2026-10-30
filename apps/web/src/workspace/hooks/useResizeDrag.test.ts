import type { PointerEvent } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createResizeDrag } from "./useResizeDrag.ts";

afterEach(() => vi.unstubAllGlobals());

function harness(axis: "x" | "y") {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { body: { style: { removeProperty: vi.fn() } } });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement;
  const resize = vi.fn((value: number) => value);
  const finish = vi.fn();
  const cleanup = vi.fn();
  const drag = createResizeDrag<HTMLElement>();

  function pointer(x: number, y: number) {
    return {
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as PointerEvent<HTMLElement>;
  }

  drag.begin(pointer(500, 500), () => ({
    width: 400,
    edge: "left",
    axis,
    bounds: { min: 180, max: 700 },
    resize,
    finish,
    cleanup,
  }));

  return { drag, target, pointer, resize, finish, cleanup };
}

it("resizes the right panel and commits once on release", () => {
  const { drag, pointer, finish, resize } = harness("x");
  drag.onPointerMove(pointer(300, 500));
  expect(finish).not.toHaveBeenCalled();
  drag.onPointerUp(pointer(250, 500));
  expect(resize).toHaveBeenLastCalledWith(650);
  expect(finish).toHaveBeenCalledExactlyOnceWith(650, true);
  drag.onLostPointerCapture(pointer(250, 500));
  expect(finish).toHaveBeenCalledTimes(1);
});

it("uses vertical movement for the terminal and respects bounds", () => {
  const { drag, pointer, finish } = harness("y");
  drag.onPointerUp(pointer(0, 100));
  expect(finish).toHaveBeenCalledExactlyOnceWith(700, true);
});

it("abandons an unmounted resize handle without persisting", () => {
  const { drag, target, pointer, finish, cleanup } = harness("x");
  drag.onPointerMove(pointer(300, 500));
  drag.ref(target)?.();
  expect(cleanup).toHaveBeenCalledWith(false);
  expect(finish).not.toHaveBeenCalled();
});
