/**
 * Dashboard Types
 *
 * Type definitions for the configurable TUI dashboard.
 */

import type { Widgets } from 'blessed';

// ============================================================================
// Panel Types
// ============================================================================

/**
 * Available panel types
 */
export type PanelType =
  | 'service-monitor'
  | 'log-viewer'
  | 'infra-status'
  | 'session-info'
  | 'module-tree'
  | 'branch-tree'
  | 'quick-actions';

/**
 * Panel position in the grid
 */
export interface PanelPosition {
  /** Starting row (0-based) */
  row: number;
  /** Starting column (0-based) */
  col: number;
  /** Number of rows to span */
  rowSpan: number;
  /** Number of columns to span */
  colSpan: number;
}

/**
 * Panel configuration
 */
export interface PanelConfig {
  /** Unique panel identifier */
  id: string;
  /** Panel type */
  type: PanelType;
  /** Position in the grid */
  position: PanelPosition;
  /** Panel-specific options */
  options?: PanelOptions;
}

/**
 * Panel-specific options
 */
export interface PanelOptions {
  /** Panel label/title */
  label?: string;
  /** Refresh interval in ms (for auto-updating panels) */
  refreshInterval?: number;
  /** Service filter (for log viewer) */
  serviceFilter?: string[];
  /** Show border */
  border?: boolean;
  /** Custom style overrides */
  style?: Record<string, unknown>;
}

// ============================================================================
// Sidebar Types
// ============================================================================

/**
 * Sidebar tab configuration
 */
export interface SidebarTab {
  /** Tab identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional icon character */
  icon?: string;
  /** Panel type to show in this tab */
  panel: PanelType;
}

/**
 * Sidebar configuration
 */
export interface SidebarConfig {
  /** Width in grid columns */
  width: number;
  /** Position */
  position: 'left' | 'right';
  /** Tabs to display */
  tabs: SidebarTab[];
}

// ============================================================================
// Layout Types
// ============================================================================

/**
 * Grid configuration
 */
export interface GridConfig {
  /** Number of rows */
  rows: number;
  /** Number of columns */
  cols: number;
}

/**
 * Complete dashboard layout configuration
 */
export interface DashboardLayout {
  /** Layout name */
  name: string;
  /** Layout description */
  description?: string;
  /** Grid configuration */
  grid: GridConfig;
  /** Sidebar configuration (optional) */
  sidebar?: SidebarConfig;
  /** Panel configurations */
  panels: PanelConfig[];
}

// ============================================================================
// Data Types
// ============================================================================

/**
 * Service status for display
 */
export interface ServiceStatus {
  name: string;
  port?: number;
  pid?: number;
  status: 'running' | 'stopped' | 'starting' | 'error';
  uptime?: string;
  cpu?: string;
  memory?: string;
}

/**
 * Infrastructure status
 */
export interface InfraStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency?: number;
  message?: string;
}

/**
 * Log entry
 */
export interface LogEntry {
  timestamp: Date;
  service: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

/**
 * Module tree node
 */
export interface ModuleTreeNode {
  name: string;
  type?: string;
  status?: 'running' | 'stopped' | 'building';
  children?: Record<string, ModuleTreeNode>;
  extended?: boolean;
}

/**
 * Branch tree node
 */
export interface BranchTreeNode {
  name: string;
  branch?: string;
  hasChanges?: boolean;
  children?: Record<string, BranchTreeNode>;
  extended?: boolean;
}

// ============================================================================
// Panel Interface
// ============================================================================

/**
 * Base panel interface that all panels must implement
 */
export interface IPanel {
  /** Panel identifier */
  id: string;
  /** Panel type */
  type: PanelType;
  /** The blessed widget */
  widget: Widgets.Node;
  /** Set the widget */
  setWidget(widget: Widgets.Node): void;
  /** Initialize the panel */
  init(): void;
  /** Update panel data */
  update(data?: unknown): void;
  /** Focus the panel */
  focus(): void;
  /** Destroy/cleanup the panel */
  destroy(): void;
}

// ============================================================================
// Dashboard State
// ============================================================================

/**
 * Dashboard runtime state
 */
export interface DashboardState {
  /** Currently focused panel ID */
  focusedPanel?: string;
  /** Active sidebar tab ID */
  activeTab?: string;
  /** Whether logs are paused */
  logsPaused: boolean;
  /** Current log filter */
  logFilter?: string;
  /** Last refresh timestamp */
  lastRefresh: Date;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Dashboard events
 */
export type DashboardEvent =
  | { type: 'focus'; panelId: string }
  | { type: 'tab-switch'; tabId: string }
  | { type: 'service-action'; action: 'start' | 'stop' | 'restart'; service: string }
  | { type: 'refresh' }
  | { type: 'quit' };

/**
 * Event handler type
 */
export type DashboardEventHandler = (event: DashboardEvent) => void | Promise<void>;
