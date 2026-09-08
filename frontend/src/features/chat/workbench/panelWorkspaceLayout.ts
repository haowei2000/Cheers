export const MESSAGE_MIN_WIDTH = 480;
export const PANEL_MIN_WIDTH = 320;
export const WORKSPACE_GAP = 8;

export function resolveWorkspaceLayout(width: number, requested: number) {
  const sideBySide =
    width >= MESSAGE_MIN_WIDTH + PANEL_MIN_WIDTH + WORKSPACE_GAP;
  return {
    sideBySide,
    panelWidth: sideBySide
      ? Math.min(
          Math.max(PANEL_MIN_WIDTH, requested),
          width - MESSAGE_MIN_WIDTH - WORKSPACE_GAP,
        )
      : width,
  };
}
