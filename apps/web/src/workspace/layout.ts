// Adapted from T3 Code's preview-panel and terminal drawer limits (MIT).
export const PANEL_DEFAULT_WIDTH = 540;
export const PANEL_MIN_WIDTH = 360;
export const TERMINAL_DEFAULT_HEIGHT = 280;

export function panelMaxWidth(viewportWidth: number, rowWidth: number) {
  return Math.max(
    PANEL_MIN_WIDTH,
    Math.min(Math.floor(viewportWidth * 0.7), rowWidth - 360),
  );
}

export function terminalMaxHeight(
  viewportHeight: number,
  columnHeight: number,
) {
  return Math.max(
    0,
    Math.min(Math.floor(viewportHeight * 0.75), columnHeight - 52 - 180),
  );
}

export function clampPanelSize(value: number, min: number, max: number) {
  return Math.min(Math.max(value, Math.min(min, max)), max);
}
