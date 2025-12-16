/**
 * Infrastructure Status Panel
 *
 * Displays health status of infrastructure services (MongoDB, Eureka, etc).
 */

import { BasePanel } from '../BasePanel.js';
import type { PanelConfig, InfraStatus, DashboardEventHandler } from '../../types.js';

// ============================================================================
// InfraStatus Panel
// ============================================================================

export class InfraStatusPanel extends BasePanel {
  private infraStatus: InfraStatus[] = [];

  constructor(config: PanelConfig, eventHandler?: DashboardEventHandler) {
    super(config, eventHandler);
  }

  /**
   * Initialize the panel
   */
  init(): void {
    this.startRefreshTimer(() => this.emit({ type: 'refresh' }));
    this.render();
  }

  /**
   * Update panel with new infrastructure status
   */
  update(data?: InfraStatus[]): void {
    if (data) {
      this.infraStatus = data;
    }

    const widget = this._widget as unknown as {
      setData: (d: { headers: string[]; data: string[][] }) => void;
    };

    if (!widget || !('setData' in widget)) return;

    const headers = ['Service', 'Status', 'Latency'];
    const rows = this.infraStatus.map((infra) => [
      infra.name,
      this.formatStatus(infra.status),
      infra.latency !== undefined ? `${infra.latency}ms` : '-',
    ]);

    widget.setData({
      headers,
      data:
        rows.length > 0
          ? rows
          : [['MongoDB', '{gray-fg}checking...{/gray-fg}', '-']],
    });

    this.render();
  }

  /**
   * Format status with color indicators
   */
  private formatStatus(status: InfraStatus['status']): string {
    switch (status) {
      case 'healthy':
        return '{green-fg}healthy{/green-fg}';
      case 'unhealthy':
        return '{red-fg}unhealthy{/red-fg}';
      case 'unknown':
      default:
        return '{yellow-fg}unknown{/yellow-fg}';
    }
  }
}

/**
 * Create table widget options for InfraStatus
 */
export function getInfraStatusWidgetOptions(label: string): Record<string, unknown> {
  return {
    label: ` ${label} `,
    keys: true,
    mouse: true,
    tags: true,
    fg: 'white',
    selectedFg: 'black',
    selectedBg: 'cyan',
    columnSpacing: 2,
    columnWidth: [14, 12, 10],
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      header: { fg: 'cyan', bold: true },
      cell: {
        fg: 'white',
        selected: { fg: 'black', bg: 'cyan' },
      },
    },
  };
}
