/**
 * Default Dashboard Layout
 *
 * Standard layout with sidebar, service monitor, log viewer, and status panels.
 */

import type { DashboardLayout } from '../../types.js';

export const defaultLayout: DashboardLayout = {
  name: 'default',
  description: 'Standard dashboard with all panels',
  grid: { rows: 12, cols: 12 },
  sidebar: {
    width: 3,
    position: 'left',
    tabs: [
      { id: 'modules', label: 'Modules', icon: '[]', panel: 'module-tree' },
      { id: 'branches', label: 'Branches', icon: '<>', panel: 'branch-tree' },
      { id: 'session', label: 'Session', icon: '()', panel: 'session-info' },
    ],
  },
  panels: [
    {
      id: 'services',
      type: 'service-monitor',
      position: { row: 0, col: 3, rowSpan: 4, colSpan: 9 },
      options: {
        label: 'Services',
        refreshInterval: 2000,
      },
    },
    {
      id: 'logs',
      type: 'log-viewer',
      position: { row: 4, col: 3, rowSpan: 6, colSpan: 9 },
      options: {
        label: 'Logs',
      },
    },
    {
      id: 'infra',
      type: 'infra-status',
      position: { row: 10, col: 3, rowSpan: 2, colSpan: 5 },
      options: {
        label: 'Infrastructure',
        refreshInterval: 5000,
      },
    },
    {
      id: 'actions',
      type: 'quick-actions',
      position: { row: 10, col: 8, rowSpan: 2, colSpan: 4 },
      options: {
        label: 'Quick Actions',
      },
    },
  ],
};
