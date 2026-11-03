import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GripVerticalIcon, PanelRightIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import "./browser.css";

interface FloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampFloatingBounds(bounds: FloatingBounds): FloatingBounds {
  const width = Math.min(Math.max(320, bounds.width), window.innerWidth - 16);
  const height = Math.min(
    Math.max(240, bounds.height),
    window.innerHeight - 16,
  );

  return {
    width,
    height,
    x: Math.max(0, Math.min(window.innerWidth - width, bounds.x)),
    y: Math.max(0, Math.min(window.innerHeight - height, bounds.y)),
  };
}

function readFloatingBounds(key: string): FloatingBounds {
  const defaults = {
    width: 640,
    height: 480,
    x: window.innerWidth - 664,
    y: window.innerHeight - 504,
  };

  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");

    if (
      value &&
      typeof value === "object" &&
      "x" in value &&
      typeof value.x === "number" &&
      Number.isFinite(value.x) &&
      "y" in value &&
      typeof value.y === "number" &&
      Number.isFinite(value.y) &&
      "width" in value &&
      typeof value.width === "number" &&
      Number.isFinite(value.width) &&
      "height" in value &&
      typeof value.height === "number" &&
      Number.isFinite(value.height)
    )
      return clampFloatingBounds({
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
      });
  } catch {
    // Storage can be unavailable or contain an older invalid value.
  }

  return clampFloatingBounds(defaults);
}

export function FloatingBrowser({
  agentId,
  children,
  onDock,
  onClose,
}: {
  agentId: string;
  children: ReactNode;
  onDock: () => void;
  onClose: () => void;
}) {
  const storageKey = `paws.floating-browser.${agentId}`;
  const [bounds, setBounds] = useState(() => readFloatingBounds(storageKey));
  const frame = useRef<HTMLElement>(null);
  const latest = useRef(bounds);
  latest.current = bounds;

  function persist(value: FloatingBounds) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // The window remains movable when browser storage is unavailable.
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => persist(bounds), 150);

    return () => clearTimeout(timer);
  }, [bounds, storageKey]);

  useEffect(() => () => persist(latest.current), [storageKey]);

  useLayoutEffect(() => {
    const node = frame.current;

    if (!node) return;

    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setBounds((current) => {
        if (current.width === rect.width && current.height === rect.height)
          return current;

        return clampFloatingBounds({
          ...current,
          width: rect.width,
          height: rect.height,
        });
      });
    });
    const clamp = () => setBounds((current) => clampFloatingBounds(current));
    observer.observe(node);
    window.addEventListener("resize", clamp);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, []);

  return (
    <section
      ref={frame}
      className="floating-browser"
      aria-label="Floating browser"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      <div
        className="floating-browser-titlebar"
        role="group"
        aria-label="Move floating browser"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;

          event.preventDefault();
          setBounds((current) =>
            clampFloatingBounds({
              ...current,
              x:
                current.x +
                (event.key === "ArrowRight"
                  ? 20
                  : event.key === "ArrowLeft"
                    ? -20
                    : 0),
              y:
                current.y +
                (event.key === "ArrowDown"
                  ? 20
                  : event.key === "ArrowUp"
                    ? -20
                    : 0),
            }),
          );
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target instanceof Element && event.target.closest("button"))
          )
            return;

          const rect =
            event.currentTarget.parentElement!.getBoundingClientRect();
          event.currentTarget.dataset.offsetX = String(
            event.clientX - rect.left,
          );
          event.currentTarget.dataset.offsetY = String(
            event.clientY - rect.top,
          );
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const target = event.currentTarget;

          if (!target.hasPointerCapture(event.pointerId)) return;

          const rect = target.parentElement!.getBoundingClientRect();
          const x = event.clientX - Number(target.dataset.offsetX);
          const y = event.clientY - Number(target.dataset.offsetY);
          setBounds((current) => ({
            ...current,
            x: Math.max(0, Math.min(window.innerWidth - rect.width, x)),
            y: Math.max(0, Math.min(window.innerHeight - rect.height, y)),
          }));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <span className="floating-browser-grip" aria-hidden>
          <GripVerticalIcon size={16} />
        </span>
        <Button
          variant="ghost"
          aria-label="Dock browser in sidebar"
          onClick={onDock}
        >
          <PanelRightIcon size={14} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          aria-label="Close floating browser"
          onClick={onClose}
        >
          <XIcon size={14} aria-hidden />
        </Button>
      </div>
      {children}
    </section>
  );
}
