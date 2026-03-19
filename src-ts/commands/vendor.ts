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
import { listVendors, loadVendorConfig, saveVendorConfig, generateVendorConfig } from '../core/config/vendor-loader.js';
import { gitInRoot, stageSubmodulePointers, commitSubmodulePointers } from '../core/utils/submodule.js';

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

  // --- vendor create ---
  vendor
    .command('create <name>')
    .description('Create a new vendor with config file and branches')
    .option('--checkout', 'Switch to the new vendor after creation')
    .option('--from <branch>', 'Base branch to create vendor branches from', 'master')
    .action(
      withErrorHandling(async (name: string, options: { checkout?: boolean; from: string }) => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        // Check if vendor already exists
        const existing = await listVendors(ctx.projectRoot);
        if (existing.includes(name)) {
          throw new VendorError(`Vendor "${name}" already exists.`, name);
        }

        // Generate and save vendor config
        const moduleNames = Object.keys(ctx.config.modules);
        const vendorConfig = generateVendorConfig(name, moduleNames);
        await saveVendorConfig(ctx.projectRoot, name, vendorConfig);
        ctx.output.success(`Created vendor config: .jic/vendors/jic.config.${name}.json`);

        // Create branches in root repo
        const branchNames = [vendorConfig.branches.master, vendorConfig.branches.dev, vendorConfig.branches.build];
        for (const branch of branchNames) {
          try {
            await gitInRoot(ctx.projectRoot, ['branch', branch, options.from]);
            ctx.output.log(`  Created branch: ${branch} (root)`);
          } catch (e) {
            if (e instanceof Error && e.message.includes('already exists')) {
              ctx.output.warn(`  Branch ${branch} already exists in root, skipping.`);
            } else {
              throw e;
            }
          }
        }

        // Create branches in submodules
        const resolvedModules = Object.values(ctx.config.resolvedModules);
        for (const mod of resolvedModules) {
          if (!vendorConfig.modules.includes(mod.name)) continue;
          for (const branch of branchNames) {
            try {
              await execa('git', ['branch', branch, options.from], { cwd: mod.absolutePath });
              ctx.output.log(`  Created branch: ${branch} (${mod.name})`);
            } catch (e) {
              if (e instanceof Error && e.message.includes('already exists')) {
                ctx.output.warn(`  Branch ${branch} already exists in ${mod.name}, skipping.`);
              } else {
                throw e;
              }
            }
          }
        }

        ctx.output.success(`Vendor "${name}" created successfully.`);

        if (options.checkout) {
          // Perform vendor checkout inline
          ctx.state.activeVendor = name;
          await ctx.saveState();

          await gitInRoot(ctx.projectRoot, ['checkout', vendorConfig.branches.master]);
          for (const mod of resolvedModules) {
            const branch = vendorConfig.modules.includes(mod.name)
              ? vendorConfig.branches.master
              : vendorConfig.nonVendorBranch ?? 'master';
            await execa('git', ['checkout', branch], { cwd: mod.absolutePath });
          }
          ctx.output.success(`Switched to vendor "${name}".`);
        }
      })
    );

  // --- vendor checkout ---
  vendor
    .command('checkout <name>')
    .description('Switch to a vendor context')
    .option('-f, --force', 'Stash uncommitted changes before switching')
    .action(
      withErrorHandling(async (name: string, options: { force?: boolean }) => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        // Guard: no switch during active session (--force does NOT bypass this)
        if (ctx.isSessionActive()) {
          const session = ctx.activeSession!;
          throw new VendorError(
            `Cannot switch vendor while session "${session.name}" is active. End or pause the session first.`,
            name
          );
        }

        // Verify vendor exists
        const vendorConfig = await loadVendorConfig(ctx.projectRoot, name);
        const vendorModuleSet = new Set(vendorConfig.modules);

        // Check for uncommitted changes
        const allModules = Object.values(ctx.config.resolvedModules);
        if (!options.force) {
          // Check root repo
          const { stdout: rootStatus } = await gitInRoot(ctx.projectRoot, ['status', '--porcelain']);
          if (rootStatus.trim().length > 0) {
            throw new VendorError(
              'Uncommitted changes in root repo. Use --force to stash.',
              name
            );
          }
          // Check submodules
          for (const mod of allModules) {
            const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: mod.absolutePath });
            if (stdout.trim().length > 0) {
              throw new VendorError(
                `Uncommitted changes in ${mod.name}. Use --force to stash.`,
                name
              );
            }
          }
        } else {
          // Stash everything
          const { stdout: rootStatus } = await gitInRoot(ctx.projectRoot, ['status', '--porcelain']);
          if (rootStatus.trim().length > 0) {
            await gitInRoot(ctx.projectRoot, ['stash', 'push', '-m', `jic-vendor-switch-${name}`]);
          }
          for (const mod of allModules) {
            const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: mod.absolutePath });
            if (stdout.trim().length > 0) {
              await execa('git', ['stash', 'push', '-m', `jic-vendor-switch-${name}`], { cwd: mod.absolutePath });
            }
          }
        }

        // Checkout root repo
        ctx.output.info(`Checking out root repo: ${vendorConfig.branches.master}`);
        await gitInRoot(ctx.projectRoot, ['checkout', vendorConfig.branches.master]);

        // Checkout modules
        for (const mod of allModules) {
          if (vendorModuleSet.has(mod.name)) {
            const branch = vendorConfig.branches.master;
            ctx.output.log(`  ${mod.name}: checkout ${branch}`);
            await execa('git', ['checkout', branch], { cwd: mod.absolutePath });
          } else {
            const branch = vendorConfig.nonVendorBranch ?? 'master';
            ctx.output.log(`  ${mod.name}: checkout ${branch}`);
            await execa('git', ['checkout', branch], { cwd: mod.absolutePath });
          }
        }

        // Update state
        ctx.state.activeVendor = name;
        await ctx.saveState();

        ctx.output.success(`Switched to vendor "${name}".`);
      })
    );

  // --- vendor add ---
  vendor
    .command('add <module>')
    .description('Add a module to the active vendor')
    .action(
      withErrorHandling(async (moduleName: string) => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        const vendorName = ctx.activeVendor;
        if (!vendorName) throw new VendorError('No active vendor.');
        if (vendorName === 'root') {
          throw new VendorError('Cannot add modules to vendor "root" — it already contains all modules.', vendorName);
        }

        // Verify module exists in root config (bypass vendor filter by checking resolvedModules directly)
        const mod = ctx.config.resolvedModules[moduleName]
          ?? Object.values(ctx.config.resolvedModules).find((m) => m.originalConfig.aliases?.includes(moduleName));
        if (!mod) {
          throw new VendorError(`Module "${moduleName}" not found in project config.`, vendorName);
        }

        // Load current vendor config
        const vendorCfg = await loadVendorConfig(ctx.projectRoot, vendorName);
        if (vendorCfg.modules.includes(mod.name)) {
          ctx.output.warn(`Module "${mod.name}" is already in vendor "${vendorName}".`);
          return;
        }

        // Create vendor branches in the module
        const branchNames = [vendorCfg.branches.master, vendorCfg.branches.dev, vendorCfg.branches.build];
        for (const branch of branchNames) {
          try {
            await execa('git', ['branch', branch, 'master'], { cwd: mod.absolutePath });
            ctx.output.log(`  Created branch: ${branch} (${mod.name})`);
          } catch (e) {
            if (e instanceof Error && e.message.includes('already exists')) {
              ctx.output.warn(`  Branch ${branch} already exists in ${mod.name}, skipping.`);
            } else {
              throw e;
            }
          }
        }

        // Update vendor config file
        vendorCfg.modules.push(mod.name);
        const { name: _, configPath: __, ...configToSave } = vendorCfg;
        await saveVendorConfig(ctx.projectRoot, vendorName, configToSave);

        // Update submodule pointer in root
        const modDir = mod.originalConfig.directory ?? mod.name;
        await stageSubmodulePointers(ctx.projectRoot, [modDir]);
        await commitSubmodulePointers(ctx.projectRoot, [mod.name]);

        ctx.output.success(`Added "${mod.name}" to vendor "${vendorName}".`);
      })
    );

  // --- vendor remove ---
  vendor
    .command('remove <module>')
    .description('Remove a module from the active vendor (does not delete branches)')
    .action(
      withErrorHandling(async (moduleName: string) => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        const vendorName = ctx.activeVendor;
        if (!vendorName) throw new VendorError('No active vendor.');
        if (vendorName === 'root') {
          throw new VendorError('Cannot remove modules from vendor "root".', vendorName);
        }

        const mod = ctx.config.resolvedModules[moduleName]
          ?? Object.values(ctx.config.resolvedModules).find((m) => m.originalConfig.aliases?.includes(moduleName));
        if (!mod) {
          throw new VendorError(`Module "${moduleName}" not found in project config.`, vendorName);
        }

        const vendorCfg = await loadVendorConfig(ctx.projectRoot, vendorName);
        if (!vendorCfg.modules.includes(mod.name)) {
          ctx.output.warn(`Module "${mod.name}" is not in vendor "${vendorName}".`);
          return;
        }

        // Guard: cannot remove last module
        if (vendorCfg.modules.length === 1) {
          throw new VendorError(
            `Cannot remove the last module from vendor "${vendorName}". Delete the vendor instead.`,
            vendorName
          );
        }

        // Update vendor config file
        vendorCfg.modules = vendorCfg.modules.filter((m) => m !== mod.name);
        const { name: _, configPath: __, ...configToSave } = vendorCfg;
        await saveVendorConfig(ctx.projectRoot, vendorName, configToSave);

        ctx.output.success(`Removed "${mod.name}" from vendor "${vendorName}". Branches not deleted.`);
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
