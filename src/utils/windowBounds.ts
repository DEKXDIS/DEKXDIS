/** Fit the visible window without overwriting the saved layout for a larger screen. */
export function fitWindowToBounds<T extends { x: number; y: number; width: number; height: number; isMinimized?: boolean }>(
  layout: T, bounds?: { width: number; height: number },
): T {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return layout;
  const width = Math.min(layout.width, bounds.width);
  const height = Math.min(layout.height, bounds.height);
  return {
    ...layout, width, height,
    x: Math.max(0, Math.min(layout.x, bounds.width - width)),
    y: Math.max(0, Math.min(layout.y, bounds.height - (layout.isMinimized ? Math.min(40, bounds.height) : height))),
  };
}
