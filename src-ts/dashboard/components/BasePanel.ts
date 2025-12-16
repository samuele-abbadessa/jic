/**
 * Base Panel
 *
 * Abstract base class for all dashboard panels.
 */

import type { Widgets } from 'blessed';
import type { IPanel, PanelConfig, PanelType, DashboardEventHandler } from '../types.js';

// ============================================================================
// BasePanel Abstract Class
// ============================================================================

export abstract class BasePanel implements IPanel {
  readonly id: string;
  readonly type: PanelType;
  protected config: PanelConfig;
  protected _widget: Widgets.Node | null = null;
  protected eventHandler?: DashboardEventHandler;
  protected refreshTimer?: ReturnType<typeof setInterval>;

  constructor(config: PanelConfig, eventHandler?: DashboardEventHandler) {
    this.id = config.id;
    this.type = config.type;
    this.config = config;
    this.eventHandler = eventHandler;
  }

  /**
   * Get the blessed widget
   */
  get widget(): Widgets.Node {
    if (!this._widget) {
      throw new Error(`Panel ${this.id} not initialized. Call init() first.`);
    }
    return this._widget;
  }

  /**
   * Set the widget (called by LayoutManager)
   */
  setWidget(widget: Widgets.Node): void {
    this._widget = widget;
    this.setupWidget();
  }

  /**
   * Setup widget event handlers - override in subclasses
   */
  protected setupWidget(): void {
    // Base setup - can be overridden
    if (this._widget) {
      // Focus styling
      this._widget.on('focus', () => {
        if ((this._widget as Widgets.BoxElement).style?.border) {
          (this._widget as Widgets.BoxElement).style.border.fg = 'green';
        }
        this._widget?.screen?.render();
      });

      this._widget.on('blur', () => {
        if ((this._widget as Widgets.BoxElement).style?.border) {
          (this._widget as Widgets.BoxElement).style.border.fg = 'cyan';
        }
        this._widget?.screen?.render();
      });
    }
  }

  /**
   * Initialize the panel - called after widget is set
   */
  abstract init(): void;

  /**
   * Update panel data
   */
  abstract update(data?: unknown): void;

  /**
   * Focus the panel
   */
  focus(): void {
    (this._widget as Widgets.BlessedElement)?.focus?.();
  }

  /**
   * Start auto-refresh if configured
   */
  protected startRefreshTimer(callback: () => void): void {
    const interval = this.config.options?.refreshInterval;
    if (interval && interval > 0) {
      this.refreshTimer = setInterval(callback, interval);
    }
  }

  /**
   * Stop auto-refresh
   */
  protected stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Emit an event to the dashboard
   */
  protected emit(event: Parameters<DashboardEventHandler>[0]): void {
    this.eventHandler?.(event);
  }

  /**
   * Destroy the panel and cleanup
   */
  destroy(): void {
    this.stopRefreshTimer();
    this._widget?.destroy();
    this._widget = null;
  }

  /**
   * Get panel label
   */
  protected getLabel(): string {
    return this.config.options?.label ?? this.id;
  }

  /**
   * Render the panel's screen
   */
  protected render(): void {
    this._widget?.screen?.render();
  }
}
