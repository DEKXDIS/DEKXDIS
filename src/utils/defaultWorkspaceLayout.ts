import type { WindowLayout } from '../components/DraggableResizableWindow';
import { STRATEGIES_ENABLED } from '../config/releaseFeatures';

export function getDefaultLayouts(width: number, height: number): Record<string, WindowLayout> {
  // Captured arrangement: chart (1253px), orders (844px), automation (430px).
  // Keep the same column proportions, allowing for usable minimum widths on smaller screens.
  const margin = Math.max(8, Math.min(12, Math.round(width * 12 / 2560)));
  const chartGap = 4;
  const automationGap = STRATEGIES_ENABLED ? 5 : 0;
  const usableWidth = Math.max(1, width - margin * 2 - chartGap - automationGap);
  const minimumScale = Math.min(1, usableWidth / (STRATEGIES_ENABLED ? 1040 : 700));
  const automationWidth = STRATEGIES_ENABLED
    ? Math.max(340 * minimumScale, Math.round(usableWidth * 430 / 2527)) : 0;
  const chartAndOrdersWidth = usableWidth - automationWidth;
  const ordersWidth = Math.max(340 * minimumScale, Math.round(chartAndOrdersWidth * 844 / 2097));
  const chartWidth = chartAndOrdersWidth - ordersWidth;
  const ordersX = margin + chartWidth + chartGap;
  const automationX = ordersX + ordersWidth + automationGap;

  // Preserve the captured vertical offsets and heights within the available canvas.
  const heightScale = Math.max(1, height - margin * 2) / 849;
  const chartHeight = Math.max(1, Math.round(846 * heightScale));
  const ordersHeight = Math.max(1, Math.round(842 * heightScale));
  const automationHeight = Math.max(1, Math.round(848 * heightScale));

  return {
    chart: {
      id: 'chart',
      title: STRATEGIES_ENABLED ? 'Multi-Token Live Chart & Signals' : 'Multi-Token Live Chart',
      x: margin, y: margin, width: chartWidth, height: chartHeight,
      minWidth: Math.min(360, chartWidth), minHeight: Math.min(200, chartHeight), zIndex: 10,
    },
    orders: {
      id: 'orders', title: 'Trade & Intent Execution Log',
      x: ordersX, y: margin + Math.round(7 * heightScale), width: ordersWidth, height: ordersHeight,
      minWidth: Math.min(340, ordersWidth), minHeight: Math.min(160, ordersHeight), zIndex: 11,
    },
    ladder: {
      id: 'ladder', title: 'Automation',
      x: automationX, y: margin, width: automationWidth, height: automationHeight,
      minWidth: Math.min(340, automationWidth), minHeight: Math.min(380, automationHeight), zIndex: 15,
    },
  };
}
