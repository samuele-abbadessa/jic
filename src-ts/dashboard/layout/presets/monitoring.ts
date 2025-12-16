/**
 * Monitoring Dashboard Layout
 *
 * Layout focused on service and infrastructure monitoring.
 */

import type { DashboardLayout } from '../../types.js';

export const monitoringLayout: DashboardLayout = {
  name: 'monitoring',
  description: 'Layout focused on service monitoring',
  grid: { rows: 12, cols: 12 },
  sidebar: {
    width: 3,
    position: 'left',
    tabs: [
      { id: 'modules', label: 'Modules', icon: '[]', panel: 'module-tree' },
      { id: 'branches', label: 'Branches', icon: '<>', panel: 'branch-tree' },
    ],
  },
  panels: [
    {
      id: 'services',
      type: 'service-monitor',
      position: { row: 0, col: 3, rowSpan: 6, colSpan: 9 },
      options: {
        label: 'Services',
        refreshInterval: 1000,
      },
    },
    {
      id: 'infra',
      type: 'infra-status',
      position: { row: 6, col: 3, rowSpan: 3, colSpan: 9 },
      options: {
        label: 'Infrastructure',
        refreshInterval: 3000,
      },
    },
    {
      id: 'logs',
      type: 'log-viewer',
      position: { row: 9, col: 3, rowSpan: 3, colSpan: 6 },
      options: {
        label: 'Recent Logs',
      },
    },
    {
      id: 'actions',
      type: 'quick-actions',
      position: { row: 9, col: 9, rowSpan: 3, colSpan: 3 },
      options: {
        label: 'Actions',
      },
    },
  ],
};
