/**
 * Vendor command for JIC CLI
 *
 * Manages vendor configurations for submodule-based projects.
 * Provides list and status subcommands for read-only operations.
 */

import { Command } from 'commander';
import { execa } from 'execa';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { VendorError, withErrorHandling } from '../core/errors/index.js';
import { listVendors } from '../core/config/vendor-loader.js';

export function registerVendorCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const vendor = program
    .command('vendor')
    .description('Manage vendor configurations for submodule-based projects');

  // --- vendor list ---
  vendor
    .command('list')
    .description('List available vendors')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        const vendors = await listVendors(ctx.projectRoot);
        const activeVendor = ctx.activeVendor;

        if (vendors.length === 0) {
          ctx.output.warn('No vendors found. Use "jic vendor create <name>" to create one.');
          return;
        }

        ctx.output.info('Available vendors:');
        for (const name of vendors) {
          const marker = name === activeVendor ? ' (active)' : '';
          ctx.output.log(`  ${name}${marker}`);
        }
      })
    );

  // --- vendor status ---
  vendor
    .command('status')
    .description('Show active vendor status')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        const vendorName = ctx.activeVendor;
        if (!vendorName) {
          ctx.output.warn('No active vendor.');
          return;
        }

        const vendorConfig = ctx.vendorConfig;
        if (!vendorConfig) {
          throw new VendorError(`Vendor config not loaded for "${vendorName}"`, vendorName);
        }

        ctx.output.info(`Vendor: ${vendorName}`);
        ctx.output.log(`Branch: ${vendorConfig.branches.master}`);
        ctx.output.log(
          `Modules: ${vendorConfig.modules.join(', ')} (${vendorConfig.modules.length}/${Object.keys(ctx.config.modules).length})`
        );
        ctx.output.log('');

        // Show per-module divergence from base branch
        const allModuleNames = Object.keys(ctx.config.modules);
        const vendorModuleSet = new Set(vendorConfig.modules);

        for (const modName of vendorConfig.modules) {
          const mod = ctx.config.resolvedModules[modName];
          if (!mod) continue;
          try {
            const { stdout } = await execa(
              'git', ['rev-list', '--count', `${vendorConfig.branches.master}..master`],
              { cwd: mod.absolutePath }
            );
            const behind = parseInt(stdout.trim(), 10);
            const behindStr = behind > 0 ? `${behind} commits behind` : 'up to date';
            ctx.output.log(`  ${modName}: ${vendorConfig.branches.master} (${behindStr})`);
          } catch {
            ctx.output.log(`  ${modName}: ${vendorConfig.branches.master} (unknown)`);
          }
        }

        ctx.output.log('');
        const nonVendorModules = allModuleNames.filter((m) => !vendorModuleSet.has(m));
        if (nonVendorModules.length > 0) {
          ctx.output.log(`Non-vendor modules: ${nonVendorModules.join(', ')}`);
        }
      })
    );
}

function assertSubmodules(ctx: IExecutionContext): void {
  if (!ctx.isSubmodules()) {
    throw new VendorError(
      'Vendor commands are only available for projects with type "submodules".'
    );
  }
}
