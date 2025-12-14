/**
 * Output utilities for consistent CLI output formatting
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import logSymbols from 'log-symbols';
import figures from 'figures';

/**
 * Color palette
 */
const colors = {
  primary: chalk.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,
  muted: chalk.gray,
  highlight: chalk.bold.white,
  module: chalk.magenta,
  command: chalk.yellow,
  path: chalk.cyan.underline
};

/**
 * Icons
 */
const icons = {
  success: logSymbols.success,
  error: logSymbols.error,
  warning: logSymbols.warning,
  info: logSymbols.info,
  arrow: figures.arrowRight,
  check: figures.tick,
  cross: figures.cross,
  bullet: figures.bullet,
  pointer: figures.pointer
};

/**
 * Output helpers
 */
export const output = {
  // Messages
  success: (msg) => console.log(`${icons.success} ${colors.success(msg)}`),
  error: (msg) => console.error(`${icons.error} ${colors.error(msg)}`),
  warning: (msg) => console.log(`${icons.warning} ${colors.warning(msg)}`),
  info: (msg) => console.log(`${icons.info} ${colors.info(msg)}`),

  // Headers
  header: (msg) => {
    console.log();
    console.log(colors.highlight(msg));
    console.log(colors.muted('─'.repeat(msg.length)));
  },

  // Subheader
  subheader: (msg) => {
    console.log();
    console.log(colors.primary(msg));
  },

  // List items
  item: (msg, indent = 0) => {
    const prefix = ' '.repeat(indent * 2) + icons.bullet;
    console.log(`${prefix} ${msg}`);
  },

  // Key-value pair
  keyValue: (key, value, indent = 0) => {
    const prefix = ' '.repeat(indent * 2);
    console.log(`${prefix}${colors.muted(key + ':')} ${value}`);
  },

  // Module name
  module: (name) => colors.module(name),

  // Command
  command: (cmd) => colors.command(cmd),

  // Path
  path: (p) => colors.path(p),

  // Muted text
  muted: (msg) => colors.muted(msg),

  // Table output
  table: (data, options = {}) => {
    const table = new Table({
      head: options.head || [],
      style: {
        head: ['cyan'],
        border: ['gray']
      },
      ...options
    });

    for (const row of data) {
      table.push(Array.isArray(row) ? row : Object.values(row));
    }

    console.log(table.toString());
  },

  // Simple list
  list: (items, options = {}) => {
    const prefix = options.numbered ? (i) => `${i + 1}.` : () => icons.bullet;
    items.forEach((item, i) => {
      console.log(`  ${prefix(i)} ${item}`);
    });
  },

  // Progress spinner
  progress: (msg) => {
    return ora({
      text: msg,
      spinner: 'dots'
    }).start();
  },

  // Blank line
  newline: () => console.log(),

  // Horizontal rule
  hr: () => console.log(colors.muted('─'.repeat(60))),

  // Box around text
  box: (msg, type = 'info') => {
    const color = colors[type] || colors.info;
    const width = Math.max(msg.length + 4, 40);
    const border = '─'.repeat(width - 2);

    console.log(color(`┌${border}┐`));
    console.log(color(`│ ${msg.padEnd(width - 4)} │`));
    console.log(color(`└${border}┘`));
  },

  // Colors and icons for external use
  colors,
  icons
};

/**
 * Create a spinner that can be used for async operations
 */
export function createSpinner(text) {
  return ora({
    text,
    spinner: 'dots',
    color: 'cyan'
  });
}

/**
 * Format a module status line
 */
export function formatModuleStatus(name, status, message = '') {
  const icon = status === 'success' ? icons.success :
               status === 'error' ? icons.error :
               status === 'warning' ? icons.warning :
               status === 'pending' ? colors.muted('○') :
               status === 'running' ? colors.primary('◉') :
               icons.bullet;

  const color = status === 'success' ? colors.success :
                status === 'error' ? colors.error :
                status === 'warning' ? colors.warning :
                status === 'pending' ? colors.muted :
                status === 'running' ? colors.primary :
                (s) => s;

  return `${icon} ${colors.module(name.padEnd(35))} ${color(message)}`;
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export default output;
