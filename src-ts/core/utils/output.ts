/**
 * Output utilities for JIC CLI
 *
 * Provides consistent console output formatting with:
 * - Color theming
 * - Spinners
 * - Tables
 * - Progress indicators
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import Table from 'cli-table3';
import figures from 'figures';
import logSymbols from 'log-symbols';

// ============================================================================
// Color Palette
// ============================================================================

/**
 * Color palette for consistent theming
 */
export const colors = {
  // Primary colors
  primary: chalk.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,
  muted: chalk.gray,
  highlight: chalk.magenta,

  // Semantic colors
  module: chalk.cyan.bold,
  command: chalk.yellow,
  path: chalk.gray,
  branch: chalk.green,
  version: chalk.magenta,
  duration: chalk.gray,
  count: chalk.cyan,

  // Status colors
  running: chalk.green,
  stopped: chalk.red,
  pending: chalk.yellow,
  skipped: chalk.gray,

  // Git colors (branch already defined in semantic colors)
  commit: chalk.yellow,
  added: chalk.green,
  deleted: chalk.red,
  modified: chalk.yellow,
} as const;

/**
 * Icons for various states and actions
 */
export const icons = {
  // Status icons
  success: logSymbols.success,
  error: logSymbols.error,
  warning: logSymbols.warning,
  info: logSymbols.info,

  // Arrows and pointers
  arrowRight: figures.arrowRight,
  arrowDown: figures.arrowDown,
  pointer: figures.pointer,
  pointerSmall: figures.pointerSmall,

  // Bullets
  bullet: figures.bullet,
  circle: figures.circle,
  circleFilled: figures.circleFilled,

  // Other
  tick: figures.tick,
  cross: figures.cross,
  star: figures.star,
  play: figures.play,
  square: figures.square,
  squareSmall: figures.squareSmall,
  line: figures.line,
  ellipsis: figures.ellipsis,
} as const;

// ============================================================================
// Output Class
// ============================================================================

/**
 * Output configuration
 */
export interface OutputOptions {
  /** Minimal output mode */
  quiet?: boolean;
  /** JSON output mode */
  json?: boolean;
  /** Verbose output mode */
  verbose?: boolean;
  /** Disable colors */
  noColor?: boolean;
}

/**
 * Main output class for formatted console output
 */
export class Output {
  private options: OutputOptions;

  constructor(options: OutputOptions = {}) {
    this.options = options;

    // Disable chalk colors if requested
    if (options.noColor) {
      chalk.level = 0;
    }
  }

  // ==========================================================================
  // Basic Output Methods
  // ==========================================================================

  /**
   * Print a line (respects quiet mode)
   */
  log(message: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log(message);
  }

  /**
   * Print verbose output (only in verbose mode)
   */
  verbose(message: string): void {
    if (!this.options.verbose || this.options.json) return;
    console.log(colors.muted(message));
  }

  /**
   * Print an error message
   */
  error(message: string): void {
    console.error(colors.error(message));
  }

  /**
   * Print a warning message
   */
  warn(message: string): void {
    if (this.options.quiet) return;
    console.warn(`${icons.warning} ${colors.warning(message)}`);
  }

  /**
   * Print a warning message (alias for warn)
   */
  warning(message: string): void {
    this.warn(message);
  }

  /**
   * Print a success message
   */
  success(message: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log(`${icons.success} ${colors.success(message)}`);
  }

  /**
   * Print an info message
   */
  info(message: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log(`${icons.info} ${colors.info(message)}`);
  }

  /**
   * Print a muted/secondary message (gray text, no icon)
   */
  muted(message: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log(colors.muted(message));
  }

  /**
   * Print a newline
   */
  newline(): void {
    if (this.options.quiet || this.options.json) return;
    console.log();
  }

  // ==========================================================================
  // Structured Output
  // ==========================================================================

  /**
   * Print a header
   */
  header(text: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log();
    console.log(colors.primary.bold(`=== ${text} ===`));
    console.log();
  }

  /**
   * Print a subheader
   */
  subheader(text: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log();
    console.log(colors.primary(`--- ${text} ---`));
    console.log();
  }

  /**
   * Print a key-value pair
   */
  keyValue(key: string, value: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log(`${colors.muted(key + ':')} ${value}`);
  }

  /**
   * Print a list item
   */
  item(text: string, indent = 0): void {
    if (this.options.quiet || this.options.json) return;
    const spaces = '  '.repeat(indent);
    console.log(`${spaces}${icons.bullet} ${text}`);
  }

  /**
   * Print a module name (formatted)
   */
  module(name: string): string {
    return colors.module(name);
  }

  /**
   * Print a command (formatted)
   */
  command(cmd: string): string {
    return colors.command(cmd);
  }

  // ==========================================================================
  // Tables
  // ==========================================================================

  /**
   * Print a table
   */
  table(
    data: Record<string, unknown>[] | string[][],
    options: {
      head?: string[];
      colWidths?: number[];
      style?: {
        head?: string[];
        border?: string[];
      };
    } = {}
  ): void {
    if (this.options.quiet) return;

    if (this.options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const tableOptions: Table.TableConstructorOptions = {
      head: options.head?.map((h) => colors.primary(h)) ?? [],
      style: {
        head: options.style?.head ?? [],
        border: options.style?.border ?? ['gray'],
      },
    };

    // Only add colWidths if it's defined (cli-table3 doesn't handle undefined well)
    if (options.colWidths) {
      tableOptions.colWidths = options.colWidths;
    }

    const table = new Table(tableOptions);

    if (Array.isArray(data) && data.length > 0) {
      if (Array.isArray(data[0])) {
        // Array of arrays
        for (const row of data as string[][]) {
          table.push(row);
        }
      } else {
        // Array of objects - convert to rows
        for (const row of data as Record<string, unknown>[]) {
          table.push(Object.values(row).map(String));
        }
      }
    }

    console.log(table.toString());
  }

  // ==========================================================================
  // Spinners
  // ==========================================================================

  /**
   * Create a spinner
   */
  spinner(text: string): Ora {
    return ora({
      text,
      spinner: 'dots',
      color: 'cyan',
      isEnabled: !this.options.quiet && !this.options.json,
    });
  }

  // ==========================================================================
  // Progress
  // ==========================================================================

  /**
   * Print phase header
   */
  phase(name: string, description: string): void {
    if (this.options.quiet || this.options.json) return;
    console.log();
    console.log(`${icons.play} ${colors.primary.bold(name)} - ${description}`);
  }

  /**
   * Print progress info
   */
  progress(current: number, total: number, label: string): void {
    if (this.options.quiet || this.options.json) return;
    const percent = Math.round((current / total) * 100);
    console.log(colors.muted(`  [${current}/${total}] ${percent}% - ${label}`));
  }

  // ==========================================================================
  // Summary
  // ==========================================================================

  /**
   * Print a summary box
   */
  summary(options: {
    title: string;
    success: number;
    failed: number;
    skipped?: number;
    duration: number;
  }): void {
    if (this.options.quiet) return;

    if (this.options.json) {
      console.log(JSON.stringify(options, null, 2));
      return;
    }

    this.newline();
    this.header(options.title);

    this.keyValue('Successful', colors.success(String(options.success)));
    this.keyValue('Failed', options.failed > 0 ? colors.error(String(options.failed)) : '0');
    if (options.skipped !== undefined) {
      this.keyValue('Skipped', colors.muted(String(options.skipped)));
    }
    this.keyValue('Duration', formatDuration(options.duration));
  }

  // ==========================================================================
  // JSON Output
  // ==========================================================================

  /**
   * Output JSON data
   */
  json(data: unknown): void {
    if (this.options.json) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format a duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format a relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Truncate a string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Pad a string to a fixed width
 */
export function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (str.length >= width) return str;
  const padding = ' '.repeat(width - str.length);
  return align === 'left' ? str + padding : padding + str;
}

// ============================================================================
// Global Output Instance
// ============================================================================

/**
 * Create an output instance with options
 */
export function createOutput(options: OutputOptions = {}): Output {
  return new Output(options);
}

/**
 * Default output instance
 */
export const output = new Output();

// Re-export spinner creator for convenience
export function createSpinner(text: string): Ora {
  return output.spinner(text);
}
