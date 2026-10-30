import { Button } from "./components/ui/button.tsx";
import { useState } from "react";
import { ThemeWireframe } from "./settings/ThemeWireframe.tsx";

const previewColors = {
  light: {
    canvas: "#fcfcfc",
    sidebar: "#fafafa",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    messageSurface: "#e4e4e7",
    messageAction: "#1b4ed8",
  },
  dark: {
    canvas: "#0a0a0a",
    sidebar: "#111111",
    surface: "#141414",
    accentSurface: "#27272a",
    messageSurface: "#27272a",
    messageAction: "#346bf1",
  },
};

const storageKey = "paws.theme";
type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);

    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function initializeTheme() {
  document.documentElement.dataset.theme = readTheme();
}

export function ThemeSelect() {
  const [theme, setTheme] = useState(readTheme);

  function changeTheme(value: Theme) {
    setTheme(value);
    document.documentElement.dataset.theme = value;

    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // Keep theme switching available when browser storage is blocked.
    }
  }

  return (
    <section className="color-scheme" aria-labelledby="color-scheme-heading">
      <h3 id="color-scheme-heading">Color scheme</h3>
      <div className="theme-options" role="group" aria-label="Color scheme">
        {(["system", "light", "dark"] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            className="theme-option"
            aria-pressed={theme === mode}
            onClick={() => changeTheme(mode)}
          >
            <ThemeWireframe
              panes={
                mode === "system"
                  ? [
                      { colors: previewColors.light, clip: "left" },
                      { colors: previewColors.dark, clip: "right" },
                    ]
                  : [{ colors: previewColors[mode] }]
              }
            />
            <span>
              {mode === "system"
                ? "System"
                : mode === "light"
                  ? "Light"
                  : "Dark"}
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
