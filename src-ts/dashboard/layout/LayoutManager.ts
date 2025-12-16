/**
 * Layout Manager
 *
 * Manages the configurable grid-based layout system for the dashboard.
 * Uses blessed-contrib's grid system under the hood.
 */

import type { Widgets } from 'blessed';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { DashboardLayout, PanelConfig, PanelPosition, SidebarConfig } from '../types.js';
import { defaultLayout } from './presets/default.js';

// ============================================================================
// Types
// ============================================================================

interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

interface CreatedWidget {
  id: string;
  widget: Widgets.Node;
  config: PanelConfig;
}

// ============================================================================
// Grid Type (blessed-contrib grid types are incomplete)
// ============================================================================

type Grid = {
  set: (
    row: number,
    col: number,
    rowSpan: number,
    colSpan: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widgetType: any,
    options?: Record<string, unknown>
  ) => Widgets.Node;
};

// ============================================================================
// LayoutManager Class
// ============================================================================

export class LayoutManager {
  private screen: Widgets.Screen;
  private grid: Grid | null = null;
  private layout: DashboardLayout;
  private widgets: Map<string, CreatedWidget> = new Map();
  private sidebarWidget: Widgets.Node | null = null;

  constructor(screen: Widgets.Screen, layout?: DashboardLayout) {
    this.screen = screen;
    this.layout = layout ?? defaultLayout;
  }

  /**
   * Initialize the layout grid
   */
  init(): void {
    // Create the grid
    this.grid = new contrib.grid({
      rows: this.layout.grid.rows,
      cols: this.layout.grid.cols,
      screen: this.screen,
    }) as Grid;
  }

  /**
   * Get the grid instance
   */
  getGrid(): Grid | null {
    return this.grid;
  }

  /**
   * Get the current layout configuration
   */
  getLayout(): DashboardLayout {
    return this.layout;
  }

  /**
   * Set a new layout
   */
  setLayout(layout: DashboardLayout): void {
    this.layout = layout;
    // Clear existing widgets
    this.widgets.clear();
    this.sidebarWidget = null;
  }

  /**
   * Calculate the actual position accounting for sidebar
   */
  private adjustPositionForSidebar(position: PanelPosition): GridCell {
    const sidebar = this.layout.sidebar;

    if (!sidebar) {
      return position;
    }

    // If sidebar is on the left and panel starts at column 0,
    // shift it by sidebar width
    if (sidebar.position === 'left') {
      return {
        ...position,
        col: position.col < sidebar.width ? sidebar.width : position.col,
      };
    }

    // If sidebar is on the right, no adjustment needed for panels
    // as they should be positioned to avoid the sidebar
    return position;
  }

  /**
   * Create a widget at a specific position
   */
  createWidget(
    _id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widgetType: any,
    position: PanelPosition,
    options: Record<string, unknown> = {}
  ): Widgets.Node {
    if (!this.grid) {
      throw new Error('LayoutManager not initialized. Call init() first.');
    }

    const adjustedPos = this.adjustPositionForSidebar(position);

    const widget = this.grid.set(
      adjustedPos.row,
      adjustedPos.col,
      adjustedPos.rowSpan,
      adjustedPos.colSpan,
      widgetType,
      options
    ) as Widgets.Node;

    return widget;
  }

  /**
   * Create sidebar placeholder box
   * The actual content will be managed by the Sidebar component
   */
  createSidebarContainer(): Widgets.Node | null {
    if (!this.grid || !this.layout.sidebar) {
      return null;
    }

    const sidebar = this.layout.sidebar;
    const col = sidebar.position === 'left' ? 0 : this.layout.grid.cols - sidebar.width;

    // Create a simple box for the sidebar container
    // The Sidebar component will create its own content (tabBar + tree)
    const sidebarBox = this.grid.set(
      0,
      col,
      this.layout.grid.rows,
      sidebar.width,
      blessed.box,
      {
        style: {
          bg: 'black',
        },
      }
    ) as Widgets.Node;

    this.sidebarWidget = sidebarBox;
    return sidebarBox;
  }

  /**
   * Get the sidebar widget
   */
  getSidebarWidget(): Widgets.Node | null {
    return this.sidebarWidget;
  }

  /**
   * Get sidebar configuration
   */
  getSidebarConfig(): SidebarConfig | undefined {
    return this.layout.sidebar;
  }

  /**
   * Get panel configurations
   */
  getPanelConfigs(): PanelConfig[] {
    return this.layout.panels;
  }

  /**
   * Store a created widget reference
   */
  registerWidget(id: string, widget: Widgets.Node, config: PanelConfig): void {
    this.widgets.set(id, { id, widget, config });
  }

  /**
   * Get a widget by ID
   */
  getWidget(id: string): CreatedWidget | undefined {
    return this.widgets.get(id);
  }

  /**
   * Get all registered widgets
   */
  getAllWidgets(): Map<string, CreatedWidget> {
    return this.widgets;
  }

  /**
   * Destroy all widgets and cleanup
   */
  destroy(): void {
    this.widgets.clear();
    this.sidebarWidget = null;
    this.grid = null;
  }
}
