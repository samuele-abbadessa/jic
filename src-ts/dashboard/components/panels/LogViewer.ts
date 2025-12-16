/**
 * Log Viewer Panel
 *
 * Displays multiplexed, color-coded logs from running services.
 */

import type { Widgets } from 'blessed';
import contrib from 'blessed-contrib';
import { BasePanel } from '../BasePanel.js';
import type { PanelConfig, LogEntry, DashboardEventHandler } from '../../types.js';

// ============================================================================
// Service Colors
// ============================================================================

const SERVICE_COLORS: Record<string, string> = {
  gws: 'cyan',
  gateway: 'cyan',
  tms: 'green',
  'tenant-main': 'green',
  tas: 'yellow',
  agenda: 'yellow',
  tns: 'magenta',
  notifications: 'magenta',
  gwc: 'white',
  frontend: 'white',
  wa: 'red',
  whatsapp: 'red',
};

// ============================================================================
// LogViewer Panel
// ============================================================================

export class LogViewerPanel extends BasePanel {
  private logs: LogEntry[] = [];
  private paused: boolean = false;
  private filter?: string;
  private maxLines: number = 1000;

  constructor(config: PanelConfig, eventHandler?: DashboardEventHandler) {
    super(config, eventHandler);
  }

  /**
   * Initialize the panel
   */
  init(): void {
    this.setupKeyBindings();
    this.render();
  }

  /**
   * Setup widget-specific key bindings
   */
  private setupKeyBindings(): void {
    const widget = this._widget as Widgets.BoxElement | null;
    if (!widget || typeof widget.key !== 'function') return;

    // Pause/resume scrolling
    widget.key('p', () => {
      this.paused = !this.paused;
      this.updateLabel();
    });
    widget.key('space', () => {
      this.paused = !this.paused;
      this.updateLabel();
    });

    // Clear logs
    widget.key('c', () => {
      this.logs = [];
      this.update();
    });

    // Filter by service (prompt would require more complex UI)
    widget.key('f', () => {
      // Toggle filter - in a full implementation, show a prompt
      this.filter = this.filter ? undefined : 'gws';
      this.updateLabel();
      this.update();
    });

    // Scroll to bottom
    widget.key('G', () => {
      const log = this._widget as ReturnType<typeof contrib.log>;
      if (log && 'setScrollPerc' in log) {
        (log as unknown as { setScrollPerc: (p: number) => void }).setScrollPerc(100);
      }
      this.render();
    });

    // Scroll to top
    widget.key('g', () => {
      const log = this._widget as ReturnType<typeof contrib.log>;
      if (log && 'setScrollPerc' in log) {
        (log as unknown as { setScrollPerc: (p: number) => void }).setScrollPerc(0);
      }
      this.render();
    });
  }

  /**
   * Update label to show pause/filter status
   */
  private updateLabel(): void {
    const parts = [this.getLabel()];
    if (this.paused) parts.push('[PAUSED]');
    if (this.filter) parts.push(`[${this.filter}]`);

    const widget = this._widget as unknown as { setLabel: (l: string) => void };
    if (widget && 'setLabel' in widget) {
      widget.setLabel(` ${parts.join(' ')} `);
    }
    this.render();
  }

  /**
   * Add a log entry
   */
  addLog(entry: LogEntry): void {
    this.logs.push(entry);

    // Trim old logs
    if (this.logs.length > this.maxLines) {
      this.logs = this.logs.slice(-this.maxLines);
    }

    // Only update display if not paused
    if (!this.paused) {
      this.appendLogLine(entry);
    }
  }

  /**
   * Append a single log line to the display
   */
  private appendLogLine(entry: LogEntry): void {
    // Skip if filtered
    if (this.filter && !entry.service.includes(this.filter)) {
      return;
    }

    const log = this._widget as ReturnType<typeof contrib.log>;
    if (!log || !('log' in log)) return;

    const line = this.formatLogEntry(entry);
    log.log(line);
  }

  /**
   * Update panel with new log data
   */
  update(data?: LogEntry[]): void {
    if (data) {
      this.logs = data;
    }

    const log = this._widget as ReturnType<typeof contrib.log>;
    if (!log || !('log' in log)) return;

    // Clear and re-render all logs (filtered)
    // Note: blessed-contrib log doesn't have a clear method, so we work with what we have
    const filteredLogs = this.filter
      ? this.logs.filter((l) => l.service.includes(this.filter!))
      : this.logs;

    // Show last N lines
    const linesToShow = filteredLogs.slice(-100);
    for (const entry of linesToShow) {
      log.log(this.formatLogEntry(entry));
    }

    this.render();
  }

  /**
   * Format a log entry with colors
   */
  private formatLogEntry(entry: LogEntry): string {
    const color = SERVICE_COLORS[entry.service] ?? 'white';
    const levelColor = this.getLevelColor(entry.level);
    const prefix = `[${entry.service}]`.padEnd(12);
    const time = entry.timestamp.toLocaleTimeString();

    return `{${color}-fg}${prefix}{/${color}-fg} {gray-fg}${time}{/gray-fg} {${levelColor}-fg}${entry.message}{/${levelColor}-fg}`;
  }

  /**
   * Get color for log level
   */
  private getLevelColor(level: LogEntry['level']): string {
    switch (level) {
      case 'error':
        return 'red';
      case 'warn':
        return 'yellow';
      case 'debug':
        return 'gray';
      default:
        return 'white';
    }
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Set pause state
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.updateLabel();
  }

  /**
   * Set filter
   */
  setFilter(filter?: string): void {
    this.filter = filter;
    this.updateLabel();
    this.update();
  }
}

/**
 * Create log widget options for LogViewer
 */
export function getLogViewerWidgetOptions(label: string): Record<string, unknown> {
  return {
    label: ` ${label} `,
    tags: true,
    scrollable: true,
    mouse: true,
    keys: true,
    scrollbar: {
      ch: ' ',
      track: { bg: 'gray' },
      style: { bg: 'cyan' },
    },
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
      bg: 'black',
    },
  };
}
