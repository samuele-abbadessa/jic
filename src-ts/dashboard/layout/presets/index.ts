/**
 * Layout Presets Index
 */

export { defaultLayout } from './default.js';
export { logsFocusedLayout } from './logs-focused.js';
export { monitoringLayout } from './monitoring.js';

import type { DashboardLayout } from '../../types.js';
import { defaultLayout } from './default.js';
import { logsFocusedLayout } from './logs-focused.js';
import { monitoringLayout } from './monitoring.js';

/**
 * All available layout presets
 */
export const layoutPresets: Record<string, DashboardLayout> = {
  default: defaultLayout,
  'logs-focused': logsFocusedLayout,
  monitoring: monitoringLayout,
};

/**
 * Get a layout preset by name
 */
export function getLayoutPreset(name: string): DashboardLayout | undefined {
  return layoutPresets[name];
}
