/**
 * Logs-Focused Dashboard Layout
 *
 * Layout optimized for log monitoring with a larger log viewer.
 */

import type { DashboardLayout } from '../../types.js';

export const logsFocusedLayout: DashboardLayout = {
  name: 'logs-focused',
  description: 'Layout optimized for log monitoring',
  grid: { rows: 12, cols: 12 },
  sidebar: {
    width: 2,
    position: 'left',
    tabs: [
      { id: 'modules', label: 'Mod', icon: '[]', panel: 'module-tree' },
      { id: 'session', label: 'Ses', icon: '()', panel: 'session-info' },
    ],
  },
  panels: [
    {
      id: 'services',
      type: 'service-monitor',
      position: { row: 0, col: 2, rowSpan: 3, colSpan: 10 },
      options: {
        label: 'Services',
        refreshInterval: 2000,
      },
    },
    {
      id: 'logs',
      type: 'log-viewer',
      position: { row: 3, col: 2, rowSpan: 9, colSpan: 10 },
      options: {
        label: 'Logs',
      },
    },
  ],
};
