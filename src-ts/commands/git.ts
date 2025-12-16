/**
 * Git Command
 *
 * Git operations across modules following the pattern: jic git <subcommand> [modules...] [options]
 *
 * Subcommands:
 *   jic git status [modules...]              - Show git status
 *   jic git checkout <branch> [modules...]   - Checkout branch
 *   jic git fetch [modules...]               - Fetch from remotes
 *   jic git pull [modules...]                - Pull current branch
 *   jic git push [modules...]                - Push current branch
 *   jic git foreach <command> [modules...]   - Run command in each module
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ResolvedModule } from '../core/types/module.js';
import { GitError, withErrorHandling } from '../core/errors/index.js';
import { exec, getGitBranch, getGitStatus, getGitCommit } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// Git Command Registration
// ============================================================================

/**
 * Register the git command
 */
export function registerGitCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const git = program.command('git').description('Git operations across submodules');

  // Status command
  git
    .command('status')
    .description('Show git status across modules')
    .argument('[modules...]', 'Modules to check (default: all)')
    .option('-s, --short', 'Short format')
    .action(
      withErrorHandling(async (modules: string[], options: { short?: boolean }) => {
        const ctx = await createContext();
        await gitStatus(ctx, modules, options);
      })
    );

  // Checkout command
  git
    .command('checkout <branch>')
    .description('Checkout branch in modules')
    .argument('[modules...]', 'Modules to checkout (default: all)')
    .option('-b, --create', 'Create branch if it does not exist')
    .option('--from <base>', 'Base branch for new branch', 'HEAD')
    .option('-f, --force', 'Force checkout even with uncommitted changes')
    .action(
      withErrorHandling(
        async (
          branch: string,
          modules: string[],
          options: { create?: boolean; from?: string; force?: boolean }
        ) => {
          const ctx = await createContext();
          await gitCheckout(ctx, branch, modules, options);
        }
      )
    );

  // Search command
  git
    .command('search <branch>')
    .description('Find modules where a branch exists')
    .option('-l, --local', 'Search only local branches')
    .option('-r, --remote', 'Search only remote branches')
    .action(
      withErrorHandling(async (branch: string, options: { local?: boolean; remote?: boolean }) => {
        const ctx = await createContext();
        await gitSearch(ctx, branch, options);
      })
    );

  // Branch subcommand
  const branchCmd = git.command('branch').description('Branch operations');

  branchCmd
    .command('create <name>')
    .description('Create a new branch in modules')
    .argument('[modules...]', 'Modules to create branch in')
    .option('--from <base>', 'Base branch', 'HEAD')
    .action(
      withErrorHandling(async (name: string, modules: string[], options: { from?: string }) => {
        const ctx = await createContext();
        await gitBranchCreate(ctx, name, modules, options);
      })
    );

  branchCmd
    .command('delete <name>')
    .description('Delete a branch in modules')
    .argument('[modules...]', 'Modules to delete branch from')
    .option('-f, --force', 'Force delete unmerged branches')
    .option('-r, --remote', 'Also delete remote branch')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      withErrorHandling(
        async (
          name: string,
          modules: string[],
          options: { force?: boolean; remote?: boolean; yes?: boolean }
        ) => {
          const ctx = await createContext();
          await gitBranchDelete(ctx, name, modules, options);
        }
      )
    );

  // Fetch command
  git
    .command('fetch')
    .description('Fetch from remotes')
    .argument('[modules...]', 'Modules to fetch')
    .option('-p, --prune', 'Prune deleted remote branches')
    .action(
      withErrorHandling(async (modules: string[], options: { prune?: boolean }) => {
        const ctx = await createContext();
        await gitFetch(ctx, modules, options);
      })
    );

  // Pull command
  git
    .command('pull')
    .description('Pull current branch from remote')
    .argument('[modules...]', 'Modules to pull')
    .option('-r, --rebase', 'Rebase instead of merge')
    .action(
      withErrorHandling(async (modules: string[], options: { rebase?: boolean }) => {
        const ctx = await createContext();
        await gitPull(ctx, modules, options);
      })
    );

  // Push command
  git
    .command('push')
    .description('Push current branch to remote')
    .argument('[modules...]', 'Modules to push')
    .option('-f, --force', 'Force push')
    .option('-u, --set-upstream', 'Set upstream tracking')
    .option('-y, --yes', 'Skip confirmation for protected branches')
    .action(
      withErrorHandling(
        async (modules: string[], options: { force?: boolean; setUpstream?: boolean; yes?: boolean }) => {
          const ctx = await createContext();
          await gitPush(ctx, modules, options);
        }
      )
    );

  // Foreach command
  git
    .command('foreach <command>')
    .description('Run git command in each module')
    .argument('[modules...]', 'Modules to run in')
    .action(
      withErrorHandling(async (command: string, modules: string[]) => {
        const ctx = await createContext();
        await gitForeach(ctx, command, modules);
      })
    );
}

// ============================================================================
// Git Status
// ============================================================================

async function gitStatus(
  ctx: IExecutionContext,
  moduleRefs: string[],
  _options: { short?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  if (ctx.json) {
    const statuses = await Promise.all(
      modules.map(async (m) => ({
        name: m.name,
        directory: m.directory,
        branch: await getGitBranch(m.absolutePath),
        status: await getGitStatus(m.absolutePath),
        commit: await getGitCommit(m.absolutePath),
      }))
    );
    ctx.output.json(statuses);
    return;
  }

  ctx.output.header('Git Status');

  const results: string[][] = [];

  for (const module of modules) {
    const branch = await getGitBranch(module.absolutePath);
    const status = await getGitStatus(module.absolutePath);
    const commit = await getGitCommit(module.absolutePath);

    let statusStr = '';
    if (status.clean) {
      statusStr = colors.success('clean');
    } else {
      const parts: string[] = [];
      if (status.modified) parts.push(colors.warning(`${status.modified}M`));
      if (status.added) parts.push(colors.success(`${status.added}A`));
      if (status.deleted) parts.push(colors.error(`${status.deleted}D`));
      if (status.untracked) parts.push(colors.muted(`${status.untracked}?`));
      statusStr = parts.join(' ');
    }

    results.push([
      ctx.output.module(module.name),
      colors.primary(branch || 'N/A'),
      colors.muted(commit?.substring(0, 7) || 'N/A'),
      statusStr,
    ]);
  }

  ctx.output.table(results, {
    head: ['Module', 'Branch', 'Commit', 'Status'],
  });
}

// ============================================================================
// Git Checkout
// ============================================================================

async function gitCheckout(
  ctx: IExecutionContext,
  branch: string,
  moduleRefs: string[],
  options: { create?: boolean; from?: string; force?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  ctx.output.header(`Checkout: ${branch}`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: checking out ${branch}`);
    spinner.start();

    try {
      // Check for uncommitted changes (skip check if --force)
      if (!options.force) {
        const status = await getGitStatus(module.absolutePath);
        if (!status.clean) {
          spinner.warn(`${module.name}: has uncommitted changes, skipping (use --force to override)`);
          skipped++;
          continue;
        }
      }

      // Check if branch exists locally
      const localExists = await branchExistsLocally(module, branch);

      let cmd: string;

      if (localExists) {
        cmd = `git checkout ${branch}`;
      } else if (options.create) {
        cmd = `git checkout -b ${branch} ${options.from || 'HEAD'}`;
      } else {
        // Try to checkout from remote
        const remoteExists = await branchExistsRemotely(module, branch);

        if (remoteExists) {
          cmd = `git checkout -b ${branch} origin/${branch}`;
        } else {
          spinner.warn(`${module.name}: branch '${branch}' not found (use -b to create)`);
          skipped++;
          continue;
        }
      }

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: on ${branch}`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: checkout failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Checkout failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Checkout complete: ${success} succeeded, ${failed} failed, ${skipped} skipped`);
}

// ============================================================================
// Git Search
// ============================================================================

async function gitSearch(
  ctx: IExecutionContext,
  branch: string,
  options: { local?: boolean; remote?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules([]);

  ctx.output.header(`Search: ${branch}`);

  const found: string[][] = [];

  for (const module of modules) {
    const localExists = options.remote ? false : await branchExistsLocally(module, branch);
    const remoteExists = options.local ? false : await branchExistsRemotely(module, branch);

    if (localExists || remoteExists) {
      const location = localExists && remoteExists ? 'local + remote' : localExists ? 'local' : 'remote';
      found.push([ctx.output.module(module.name), colors.success(location)]);
    }
  }

  if (found.length === 0) {
    ctx.output.warning(`Branch '${branch}' not found in any module`);
    return;
  }

  ctx.output.table(found, {
    head: ['Module', 'Location'],
  });

  ctx.output.newline();
  ctx.output.info(`Found in ${found.length} module(s)`);
}

// ============================================================================
// Git Branch Create
// ============================================================================

async function gitBranchCreate(
  ctx: IExecutionContext,
  name: string,
  moduleRefs: string[],
  options: { from?: string }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);
  const base = options.from || 'HEAD';

  ctx.output.header(`Create Branch: ${name}`);
  ctx.output.keyValue('Base', base);
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: creating ${name}`);
    spinner.start();

    try {
      const exists = await branchExistsLocally(module, name);
      if (exists) {
        spinner.warn(`${module.name}: branch already exists`);
        continue;
      }

      const cmd = `git checkout -b ${name} ${base}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: created ${name}`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: failed to create branch`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Branch creation failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Branch creation complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Git Branch Delete
// ============================================================================

async function gitBranchDelete(
  ctx: IExecutionContext,
  name: string,
  moduleRefs: string[],
  options: { force?: boolean; remote?: boolean; yes?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  // Filter to only modules where the branch exists
  const modulesWithBranch: ResolvedModule[] = [];
  for (const module of modules) {
    if (await branchExistsLocally(module, name)) {
      modulesWithBranch.push(module);
    }
  }

  if (modulesWithBranch.length === 0) {
    ctx.output.warning(`Branch '${name}' not found in any module`);
    return;
  }

  ctx.output.header(`Delete Branch: ${name}`);
  ctx.output.keyValue('Modules', modulesWithBranch.map((m) => m.name).join(', '));
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of modulesWithBranch) {
    const spinner = ctx.output.spinner(`${module.name}: deleting ${name}`);
    spinner.start();

    try {
      const deleteFlag = options.force ? '-D' : '-d';
      const cmd = `git branch ${deleteFlag} ${name}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });

      // Delete remote if requested
      if (options.remote) {
        const remoteExists = await branchExistsRemotely(module, name);
        if (remoteExists) {
          await exec(`git push origin --delete ${name}`, {
            cwd: module.absolutePath,
            silent: true,
          });
        }
      }

      spinner.succeed(`${module.name}: deleted ${name}`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: failed to delete branch`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;
    }
  }

  ctx.output.newline();
  ctx.output.info(`Branch deletion complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Git Fetch
// ============================================================================

async function gitFetch(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { prune?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  ctx.output.header('Git Fetch');

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: fetching`);
    spinner.start();

    try {
      let cmd = 'git fetch';
      if (options.prune) cmd += ' --prune';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: fetched`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: fetch failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;
    }
  }

  ctx.output.newline();
  ctx.output.info(`Fetch complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Git Pull
// ============================================================================

async function gitPull(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { rebase?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  ctx.output.header('Git Pull');

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: pulling`);
    spinner.start();

    try {
      // Check for uncommitted changes
      const status = await getGitStatus(module.absolutePath);
      if (!status.clean) {
        spinner.warn(`${module.name}: has uncommitted changes, skipping`);
        continue;
      }

      let cmd = 'git pull';
      if (options.rebase) cmd += ' --rebase';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: pulled`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: pull failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Pull failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Pull complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Git Push
// ============================================================================

const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'production', 'prod'];

async function gitPush(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { force?: boolean; setUpstream?: boolean; yes?: boolean }
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  ctx.output.header('Git Push');

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: pushing`);
    spinner.start();

    try {
      const branch = await getGitBranch(module.absolutePath);

      // Warn about force push to protected branches
      if (options.force && branch && PROTECTED_BRANCHES.includes(branch) && !options.yes) {
        spinner.warn(
          `${module.name}: force push to protected branch '${branch}' - skipping (use -y to override)`
        );
        continue;
      }

      let cmd = 'git push';
      if (options.force) cmd += ' --force';
      if (options.setUpstream) cmd += ' -u origin ' + (branch || 'HEAD');

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: pushed`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: push failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Push failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Push complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Git Foreach
// ============================================================================

async function gitForeach(
  ctx: IExecutionContext,
  command: string,
  moduleRefs: string[]
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);

  ctx.output.header(`Git Foreach: ${command}`);

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: running command`);
    spinner.start();

    try {
      const fullCmd = `git ${command}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${fullCmd}`);
        success++;
        continue;
      }

      const result = await exec(fullCmd, { cwd: module.absolutePath, silent: !ctx.verbose });

      if (result.stdout && ctx.verbose) {
        console.log(result.stdout);
      }

      spinner.succeed(`${module.name}: done`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: command failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Command failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Foreach complete: ${success} succeeded, ${failed} failed`);
}

// ============================================================================
// Helper Functions
// ============================================================================

async function branchExistsLocally(module: ResolvedModule, branch: string): Promise<boolean> {
  try {
    await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
      cwd: module.absolutePath,
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function branchExistsRemotely(module: ResolvedModule, branch: string): Promise<boolean> {
  try {
    await exec(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, {
      cwd: module.absolutePath,
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}
