/**
 * Service Monitor Panel
 *
 * Displays running services with status, port, PID, uptime, and resource usage.
 */

import type { Widgets } from 'blessed';
import contrib from 'blessed-contrib';
import { BasePanel } from '../BasePanel.js';
import type { PanelConfig, ServiceStatus, DashboardEventHandler } from '../../types.js';

// ============================================================================
// ServiceMonitor Panel
// ============================================================================

export class ServiceMonitorPanel extends BasePanel {
  private services: ServiceStatus[] = [];

  constructor(config: PanelConfig, eventHandler?: DashboardEventHandler) {
    super(config, eventHandler);
  }

  /**
   * Initialize the panel
   */
  init(): void {
    this.setupKeyBindings();
    this.startRefreshTimer(() => this.update());
    this.render();
  }

  /**
   * Setup widget-specific key bindings
   */
  private setupKeyBindings(): void {
    const widget = this._widget as Widgets.BoxElement | null;
    if (!widget || typeof widget.key !== 'function') return;

    // Start service
    widget.key('s', () => {
      const selected = this.getSelectedService();
      if (selected) {
        this.emit({ type: 'service-action', action: 'start', service: selected.name });
      }
    });

    // Stop service
    widget.key('x', () => {
      const selected = this.getSelectedService();
      if (selected) {
        this.emit({ type: 'service-action', action: 'stop', service: selected.name });
      }
    });

    // Restart service
    widget.key('r', () => {
      const selected = this.getSelectedService();
      if (selected) {
        this.emit({ type: 'service-action', action: 'restart', service: selected.name });
      }
    });
  }

  /**
   * Get currently selected service
   */
  private getSelectedService(): ServiceStatus | undefined {
    const table = this._widget as ReturnType<typeof contrib.table>;
    if (!table || !('rows' in table)) return undefined;

    // Get selected row index
    const selectedIndex = (table as unknown as { selected: number }).selected ?? 0;
    return this.services[selectedIndex];
  }

  /**
   * Update panel with new service data
   */
  update(data?: ServiceStatus[]): void {
    if (data) {
      this.services = data;
    }

    const table = this._widget as ReturnType<typeof contrib.table>;
    if (!table) return;

    const headers = ['Service', 'Port', 'PID', 'Status', 'Uptime'];
    const rows = this.services.map((svc) => [
      svc.name,
      svc.port?.toString() ?? '-',
      svc.pid?.toString() ?? '-',
      this.formatStatus(svc.status),
      svc.uptime ?? '-',
    ]);

    table.setData({
      headers,
      data: rows.length > 0 ? rows : [['No services', '-', '-', '-', '-']],
    });

    this.render();
  }

  /**
   * Format status with color indicators
   */
  private formatStatus(status: ServiceStatus['status']): string {
    switch (status) {
      case 'running':
        return '{green-fg}running{/green-fg}';
      case 'stopped':
        return '{red-fg}stopped{/red-fg}';
      case 'starting':
        return '{yellow-fg}starting{/yellow-fg}';
      case 'error':
        return '{red-fg}error{/red-fg}';
      default:
        return status;
    }
  }
}

/**
 * Create table widget options for ServiceMonitor
 */
export function getServiceMonitorWidgetOptions(label: string): Record<string, unknown> {
  return {
    label: ` ${label} `,
    keys: true,
    mouse: true,
    interactive: true,
    tags: true,
    fg: 'white',
    selectedFg: 'black',
    selectedBg: 'cyan',
    columnSpacing: 3,
    columnWidth: [20, 8, 10, 12, 12],
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
