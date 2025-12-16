/**
 * Dashboard Command
 *
 * Registers the `jic dashboard` command for the TUI monitoring interface.
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { Dashboard } from './Dashboard.js';
import { layoutPresets } from './layout/presets/index.js';

// ============================================================================
// Dashboard Command Registration
// ============================================================================

export function registerDashboardCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('dashboard')
    .alias('dash')
    .description('Open TUI monitoring dashboard')
    .option('-l, --layout <name>', 'Layout preset (default, logs-focused, monitoring)', 'default')
    .option('--list-layouts', 'List available layout presets')
    .action(async (options: { layout?: string; listLayouts?: boolean }) => {
      // List layouts if requested
      if (options.listLayouts) {
        console.log('\nAvailable layout presets:\n');
        for (const [name, layout] of Object.entries(layoutPresets)) {
          console.log(`  ${name.padEnd(15)} - ${layout.description ?? 'No description'}`);
        }
        console.log('\nUse: jic dashboard --layout <name>\n');
        return;
      }

      try {
        // Create context
        const ctx = await createContext();

        // Create and start dashboard
        const dashboard = new Dashboard(ctx, options.layout);
        await dashboard.start();
      } catch (error) {
        if (error instanceof Error) {
          console.error('Dashboard error:', error.message);
          console.error('Stack:', error.stack);
        } else {
          console.error('Dashboard error:', error);
        }
        process.exit(1);
      }
    });
}

// Re-export types and components for external use
export { Dashboard } from './Dashboard.js';
export { LayoutManager } from './layout/LayoutManager.js';
export { DataProvider } from './services/DataProvider.js';
export * from './types.js';
export * from './layout/presets/index.js';
