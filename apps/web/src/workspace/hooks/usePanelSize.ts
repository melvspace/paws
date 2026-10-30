import { useLayoutEffect, useState } from "react";
import { clampPanelSize } from "../layout.ts";
import { useResizeDrag } from "./useResizeDrag.ts";

interface PanelSizeOptions {
  storageKey: string;
  defaultSize: number;
  min: number;
  max: number;
  axis: "x" | "y";
}

// T3 Code updates a CSS property during drag and commits storage only on release.
export function usePanelSize(options: PanelSizeOptions) {
  const { storageKey, defaultSize, min, max, axis } = options;
  const [savedSize, setSavedSize] = useState(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "null",
      );

      return typeof stored === "number" && Number.isFinite(stored)
        ? stored
        : defaultSize;
    } catch {
      return defaultSize;
    }
  });
  const size = clampPanelSize(savedSize, min, max);

  function commit(value: number) {
    const next = clampPanelSize(value, min, max);
    setSavedSize(next);

    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Resizing remains available when browser storage is blocked.
    }
  }

  const drag = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;

    return {
      width: size,
      edge: "left",
      axis,
      bounds: { min: Math.min(min, max), max },
      resize(nextSize) {
        host?.style.setProperty("--panel-size", `${nextSize}px`);

        return nextSize;
      },
      finish: commit,
      cleanup(committed) {
        if (!committed) {
          host?.style.setProperty("--panel-size", `${size}px`);
        }
      },
    };
  });
  const { refresh } = drag;

  // Re-clamp the active drag before paint when the surrounding layout changes.
  useLayoutEffect(
    () => refresh({ min: Math.min(min, max), max }),
    [refresh, min, max],
  );

  return {
    size,
    handle: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
      onDoubleClick: () => commit(defaultSize),
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        const increase = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const decrease = axis === "x" ? "ArrowRight" : "ArrowDown";

        if (event.key === increase || event.key === decrease) {
          event.preventDefault();
          commit(size + (event.key === increase ? 20 : -20));
        }
      },
    },
  };
}
