/**
 * Quick Actions Panel
 *
 * Displays keyboard shortcuts and allows quick actions.
 */

import blessed from 'blessed';
import { BasePanel } from '../BasePanel.js';
import type { PanelConfig, DashboardEventHandler } from '../../types.js';

// ============================================================================
// QuickActions Panel
// ============================================================================

const SHORTCUTS = [
  { key: 'Tab', action: 'Next panel' },
  { key: 'S-Tab', action: 'Prev panel' },
  { key: '1-3', action: 'Switch tab' },
  { key: 's', action: 'Start service' },
  { key: 'x', action: 'Stop service' },
  { key: 'r', action: 'Restart service' },
  { key: 'p', action: 'Pause logs' },
  { key: 'R', action: 'Refresh all' },
  { key: '?', action: 'Help' },
  { key: 'q', action: 'Quit' },
];

export class QuickActionsPanel extends BasePanel {
  constructor(config: PanelConfig, eventHandler?: DashboardEventHandler) {
    super(config, eventHandler);
  }

  /**
   * Initialize the panel
   */
  init(): void {
    this.update();
  }

  /**
   * Update panel content
   */
  update(_data?: unknown): void {
    const widget = this._widget as blessed.Widgets.BoxElement;
    if (!widget || !('setContent' in widget)) return;

    const content = SHORTCUTS.map(
      (s) => `{cyan-fg}${s.key.padEnd(8)}{/cyan-fg} ${s.action}`
    ).join('\n');

    widget.setContent(content);
    this.render();
  }
}

/**
 * Create box widget options for QuickActions
 */
export function getQuickActionsWidgetOptions(label: string): Record<string, unknown> {
  return {
    label: ` ${label} `,
    tags: true,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
    },
  };
}
