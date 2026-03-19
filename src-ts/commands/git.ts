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
import { gitInRoot, stageSubmodulePointers, commitSubmodulePointers } from '../core/utils/submodule.js';

// ============================================================================
// Git Command Registration
// ============================================================================

/**
 * Common git command options
 */
interface GitGlobalOptions {
  global?: boolean;
}

/**
 * Log session mode info at start of git operations
 */
function logSessionMode(ctx: IExecutionContext, options: GitGlobalOptions, moduleRefs: string[]): void {
  const hasExplicitModules = moduleRefs.length > 0;
  const isGlobal = options.global === true;

  if (hasExplicitModules) {
    // User explicitly specified modules, no session mode message needed
    return;
  }

  if (ctx.isSessionActive() && !isGlobal) {
    const session = ctx.activeSession!;
    const moduleCount = Object.keys(session.modules).length;
    ctx.output.info(`Session mode: ${session.name} (${moduleCount} modules)`);
    ctx.output.muted('Use --global to run across all modules');
    ctx.output.newline();
  } else if (ctx.isSessionActive() && isGlobal) {
    ctx.output.info('Global mode: running across all modules');
    ctx.output.newline();
  }
}

/**
 * Resolve modules considering --global flag
 */
function resolveGitModules(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: GitGlobalOptions
): ResolvedModule[] {
  // If --global is set, ignore session and get all modules
  if (options.global) {
    return Object.values(ctx.config.resolvedModules);
  }
  // Otherwise, use default resolution (session-aware)
  return ctx.resolveModules(moduleRefs);
}

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
    .argument('[modules...]', 'Modules to check (default: all or session modules)')
    .option('-s, --short', 'Short format')
    .option('-l, --list-files', 'Show list of changed files (tracked and untracked)')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: { short?: boolean; listFiles?: boolean } & GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitStatus(ctx, modules, options);
      })
    );

  // Checkout command
  git
    .command('checkout [branch]')
    .description('Checkout branch in modules (default: checkout to default local branch)')
    .argument('[modules...]', 'Modules to checkout (default: all or session modules)')
    .option('-b, --create', 'Create branch if it does not exist')
    .option('--from <base>', 'Base branch for new branch', 'HEAD')
    .option('-f, --force', 'Force checkout even with uncommitted changes')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (
          branch: string | undefined,
          modules: string[],
          options: { create?: boolean; from?: string; force?: boolean } & GitGlobalOptions
        ) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
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
    .argument('[modules...]', 'Modules to fetch (default: all or session modules)')
    .option('-p, --prune', 'Prune deleted remote branches')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: { prune?: boolean } & GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitFetch(ctx, modules, options);
      })
    );

  // Pull command
  git
    .command('pull')
    .description('Pull current branch from remote')
    .argument('[modules...]', 'Modules to pull (default: all or session modules)')
    .option('-r, --rebase', 'Rebase instead of merge')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: { rebase?: boolean } & GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitPull(ctx, modules, options);
      })
    );

  // Push command
  git
    .command('push')
    .description('Push current branch to remote')
    .argument('[modules...]', 'Modules to push (default: all or session modules)')
    .option('-f, --force', 'Force push')
    .option('-u, --set-upstream', 'Set upstream tracking')
    .option('-y, --yes', 'Skip confirmation for protected branches')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (modules: string[], options: { force?: boolean; setUpstream?: boolean; yes?: boolean } & GitGlobalOptions) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitPush(ctx, modules, options);
        }
      )
    );

  // Foreach command
  git
    .command('foreach <command>')
    .description('Run git command in each module')
    .argument('[modules...]', 'Modules to run in (default: all or session modules)')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (command: string, modules: string[], options: GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitForeach(ctx, command, modules, options);
      })
    );

  // Diff command - see all changes across modules
  git
    .command('diff')
    .description('Show diff across modules in one view')
    .argument('[modules...]', 'Modules to diff (default: all or session modules)')
    .option('-s, --stat', 'Show diffstat only')
    .option('--staged', 'Show staged changes only')
    .option('--cached', 'Alias for --staged')
    .option('-b, --base <ref>', 'Compare against base ref (branch/commit)')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (
          modules: string[],
          options: { stat?: boolean; staged?: boolean; cached?: boolean; base?: string } & GitGlobalOptions
        ) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitDiff(ctx, modules, options);
        }
      )
    );

  // Log command - show commits across modules
  git
    .command('log')
    .description('Show recent commits across modules')
    .argument('[modules...]', 'Modules to show (default: all or session modules)')
    .option('-n, --max-count <n>', 'Maximum commits per module', '5')
    .option('--since <date>', 'Show commits since date (e.g., "1 week ago")')
    .option('--author <name>', 'Filter by author')
    .option('--oneline', 'Compact one-line format')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (
          modules: string[],
          options: { maxCount?: string; since?: string; author?: string; oneline?: boolean } & GitGlobalOptions
        ) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitLog(ctx, modules, options);
        }
      )
    );

  // Changelog command - generate changelog from commits
  git
    .command('changelog')
    .description('Generate changelog from commits across modules')
    .argument('[modules...]', 'Modules to include (default: all or session modules)')
    .option('--since <ref>', 'Starting point (tag, branch, or commit)', 'HEAD~20')
    .option('--until <ref>', 'Ending point', 'HEAD')
    .option('--format <fmt>', 'Output format (markdown, text)', 'markdown')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (
          modules: string[],
          options: { since?: string; until?: string; format?: string } & GitGlobalOptions
        ) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitChangelog(ctx, modules, options);
        }
      )
    );

  // Graph command - visual branch overview across modules
  git
    .command('graph')
    .description('Show branch graph across modules (like git log --graph but multi-repo)')
    .argument('[modules...]', 'Modules to show (default: all or session modules)')
    .option('-n, --max-count <n>', 'Maximum commits per module', '10')
    .option('-a, --all', 'Show all branches, not just current')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (modules: string[], options: { maxCount?: string; all?: boolean } & GitGlobalOptions) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitGraph(ctx, modules, options);
        }
      )
    );

  // Stash command - multi-module stash
  const stash = git.command('stash').description('Stash operations across modules');

  stash
    .command('save [message]')
    .description('Stash changes in modules with uncommitted changes')
    .argument('[modules...]', 'Modules to stash (default: all with changes)')
    .option('-u, --include-untracked', 'Include untracked files')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (message: string | undefined, modules: string[], options: { includeUntracked?: boolean } & GitGlobalOptions) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitStashSave(ctx, message, modules, options);
        }
      )
    );

  stash
    .command('pop')
    .description('Pop stash in modules')
    .argument('[modules...]', 'Modules to pop stash (default: all with stashes)')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitStashPop(ctx, modules, options);
      })
    );

  stash
    .command('list')
    .description('List stashes in modules')
    .argument('[modules...]', 'Modules to list stashes')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitStashList(ctx, modules, options);
      })
    );

  stash
    .command('drop')
    .description('Drop stash in modules')
    .argument('[modules...]', 'Modules to drop stash')
    .option('-a, --all', 'Drop all stashes')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(async (modules: string[], options: { all?: boolean } & GitGlobalOptions) => {
        const ctx = await createContext();
        logSessionMode(ctx, options, modules);
        await gitStashDrop(ctx, modules, options);
      })
    );

  // Sync command - sync current branch with base
  git
    .command('sync')
    .description('Sync current branch with base branch (pull + rebase/merge)')
    .argument('[modules...]', 'Modules to sync')
    .option('-m, --merge', 'Use merge instead of rebase')
    .option('-b, --base <branch>', 'Base branch to sync from (default: from module config)')
    .option('--no-pull', 'Skip pulling base branch first')
    .option('-g, --global', 'Run across all modules (ignore active session)')
    .action(
      withErrorHandling(
        async (
          modules: string[],
          options: { merge?: boolean; base?: string; pull?: boolean } & GitGlobalOptions
        ) => {
          const ctx = await createContext();
          logSessionMode(ctx, options, modules);
          await gitSync(ctx, modules, options);
        }
      )
    );

  // Commit command - quick commit in session modules
  git
    .command('commit')
    .description('Add and commit all changes in session modules (session only)')
    .option('-m, --message <message>', 'Commit message (default: session description)')
    .option('-a, --amend', 'Amend the previous commit')
    .option('--update-root', 'Also commit submodule pointer changes in root repo')
    .action(
      withErrorHandling(async (options: { message?: string; amend?: boolean; updateRoot?: boolean }) => {
        const ctx = await createContext();
        await gitCommit(ctx, options);
      })
    );
}

// ============================================================================
// Git Status
// ============================================================================

async function gitStatus(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { short?: boolean; listFiles?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);
  const showFiles = options.listFiles === true;

  // Root repo status for submodules projects
  if (ctx.isSubmodules()) {
    ctx.output.info('Root repo:');
    try {
      const { stdout } = await gitInRoot(ctx.projectRoot, ['status', '--short']);
      if (stdout.trim()) {
        ctx.output.log(stdout);
      } else {
        ctx.output.log('  Clean');
      }
      const { stdout: branch } = await gitInRoot(ctx.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      ctx.output.log(`  Branch: ${branch.trim()}`);
    } catch {
      ctx.output.log('  (unable to read root repo status)');
    }
    ctx.output.log('');
  }

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
  let totalFiles = 0;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let modulesWithChanges = 0;

  // Collect file listings for verbose mode
  const moduleFileListings: Map<string, string[]> = new Map();

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

      // Collect diff stats for modules with changes
      const diffStats = await getModuleDiffStats(module.absolutePath, {});
      if (diffStats.filesChanged > 0) {
        modulesWithChanges++;
        totalFiles += diffStats.filesChanged;
        totalInsertions += diffStats.insertions;
        totalDeletions += diffStats.deletions;
      }
    }

    // Get file listing when --list-files is set
    if (showFiles) {
      const files = await getModuleFileStatus(module.absolutePath);
      if (files.length > 0) {
        moduleFileListings.set(module.name, files);
      }
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

  // Show file listings when --list-files is set
  if (showFiles) {
    ctx.output.newline();
    ctx.output.subheader('Changed Files');

    if (moduleFileListings.size === 0) {
      ctx.output.muted('No changed files');
    } else {
      for (const [moduleName, files] of moduleFileListings) {
        ctx.output.newline();
        ctx.output.info(`${moduleName}:`);
        for (const file of files) {
          console.log(`  ${file}`);
        }
      }
    }
  }

  // Show summary stats if there are changes
  if (modulesWithChanges > 0) {
    ctx.output.newline();
    ctx.output.muted(
      `Stats: ${modulesWithChanges} modules with changes, ${totalFiles} files, ` +
      `${colors.success(`+${totalInsertions}`)} ${colors.error(`-${totalDeletions}`)}`
    );
  }

  // Show session info if active
  if (ctx.isSessionActive()) {
    const session = ctx.activeSession!;
    const startTime = new Date(session.createdAt);
    const elapsed = Date.now() - startTime.getTime();
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const elapsedStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    ctx.output.muted(`Session: ${session.name} (${elapsedStr} elapsed)`);
  }
}

/**
 * Get list of changed files for --list-files output
 */
async function getModuleFileStatus(modulePath: string): Promise<string[]> {
  try {
    const result = await exec('git status --porcelain', {
      cwd: modulePath,
      silent: true,
    });

    const lines = result.stdout?.trim().split('\n').filter(Boolean) ?? [];
    return lines.map((line) => {
      // git status --porcelain format: XY FILENAME
      // XY = 2 character status, then space, then filename
      const status = line.slice(0, 2);
      const file = line.slice(2).trimStart(); // Skip status, trim leading space

      // Color-code based on status
      let statusLabel: string;
      const statusTrimmed = status.trim();
      switch (statusTrimmed) {
        case 'M':
        case 'MM':
          statusLabel = colors.warning('M');
          break;
        case 'A':
        case 'AM':
          statusLabel = colors.success('A');
          break;
        case 'D':
          statusLabel = colors.error('D');
          break;
        case 'R':
        case 'RM':
          statusLabel = colors.primary('R');
          break;
        case 'C':
          statusLabel = colors.primary('C');
          break;
        case '??':
          statusLabel = colors.muted('?');
          break;
        case '!!':
          statusLabel = colors.muted('!');
          break;
        default:
          statusLabel = colors.muted(status);
      }

      return `${statusLabel} ${file}`;
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Git Checkout
// ============================================================================

async function gitCheckout(
  ctx: IExecutionContext,
  branch: string | undefined,
  moduleRefs: string[],
  options: { create?: boolean; from?: string; force?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  // Determine if we're using per-module default branches
  const useDefaultBranches = branch === undefined;

  if (useDefaultBranches) {
    ctx.output.header('Checkout: default local branches');
  } else {
    ctx.output.header(`Checkout: ${branch}`);
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const module of modules) {
    // Determine target branch for this module
    let targetBranch: string;
    if (useDefaultBranches) {
      targetBranch = module.branches?.local ?? ctx.config.defaults.branches?.local ?? 'main';
    } else {
      targetBranch = branch;
    }

    const spinner = ctx.output.spinner(`${module.name}: checking out ${targetBranch}`);
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
      const localExists = await branchExistsLocally(module, targetBranch);

      let cmd: string;

      if (localExists) {
        cmd = `git checkout ${targetBranch}`;
      } else if (options.create) {
        cmd = `git checkout -b ${targetBranch} ${options.from || 'HEAD'}`;
      } else {
        // Try to checkout from remote
        const remoteExists = await branchExistsRemotely(module, targetBranch);

        if (remoteExists) {
          cmd = `git checkout -b ${targetBranch} origin/${targetBranch}`;
        } else {
          spinner.warn(`${module.name}: branch '${targetBranch}' not found (use -b to create)`);
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
      spinner.succeed(`${module.name}: on ${targetBranch}`);
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
  options: { prune?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  // Fetch root repo first for submodules projects
  if (ctx.isSubmodules()) {
    ctx.output.info('Fetching root repo...');
    try {
      await gitInRoot(ctx.projectRoot, ['fetch', '--all']);
      ctx.output.success('  Root repo: fetched');
    } catch {
      ctx.output.warn('  Root repo: fetch failed');
    }
  }

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
  options: { rebase?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  // Pull root repo first for submodules projects
  if (ctx.isSubmodules()) {
    ctx.output.info('Pulling root repo...');
    try {
      await gitInRoot(ctx.projectRoot, ['pull']);
      ctx.output.success('  Root repo: pulled');
    } catch {
      ctx.output.warn('  Root repo: pull failed');
    }
  }

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
  options: { force?: boolean; setUpstream?: boolean; yes?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

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

  // Push root repo last for submodules projects (after submodules)
  if (ctx.isSubmodules()) {
    ctx.output.info('Pushing root repo...');
    try {
      if (ctx.dryRun) {
        ctx.output.info('  [dry-run] Would push root repo');
      } else {
        await gitInRoot(ctx.projectRoot, ['push']);
        ctx.output.success('  Root repo: pushed');
      }
    } catch {
      ctx.output.warn('  Root repo: push failed');
    }
  }
}

// ============================================================================
// Git Foreach
// ============================================================================

async function gitForeach(
  ctx: IExecutionContext,
  command: string,
  moduleRefs: string[],
  options: GitGlobalOptions = {}
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  ctx.output.header(`Git Foreach: ${command}`);

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    ctx.output.subheader(module.name);

    try {
      const fullCmd = `git ${command}`;

      if (ctx.dryRun) {
        ctx.output.info(`[dry-run] ${fullCmd}`);
        success++;
        continue;
      }

      const result = await exec(fullCmd, { cwd: module.absolutePath, silent: true });

      // Always show output
      if (result.stdout?.trim()) {
        console.log(result.stdout);
      }
      if (result.stderr?.trim()) {
        console.error(colors.muted(result.stderr));
      }

      if (!result.stdout?.trim() && !result.stderr?.trim()) {
        ctx.output.muted('(no output)');
      }

      success++;
    } catch (error) {
      ctx.output.error(`Command failed`);
      if (error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Command failed for ${module.name}`, { moduleName: module.name });
      }
    }

    ctx.output.newline();
  }

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

// ============================================================================
// Git Diff - Unified diff across modules
// ============================================================================

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

async function getModuleDiffStats(modulePath: string, options: { staged?: boolean; base?: string }): Promise<DiffStats> {
  try {
    let cmd = 'git diff --shortstat';
    if (options.staged) cmd += ' --staged';
    if (options.base) cmd += ` ${options.base}...HEAD`;

    const result = await exec(cmd, { cwd: modulePath, silent: true });
    const output = result.stdout?.trim() || '';

    // Parse: " 3 files changed, 10 insertions(+), 5 deletions(-)"
    const filesMatch = output.match(/(\d+) files? changed/);
    const insertMatch = output.match(/(\d+) insertions?\(\+\)/);
    const deleteMatch = output.match(/(\d+) deletions?\(-\)/);

    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
    };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

async function gitDiff(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { stat?: boolean; staged?: boolean; cached?: boolean; base?: string } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);
  const staged = options.staged || options.cached;

  if (options.stat) {
    // Show diff stats summary
    ctx.output.header('Diff Stats');

    if (options.base) {
      ctx.output.keyValue('Comparing', `${options.base}...HEAD`);
    } else if (staged) {
      ctx.output.keyValue('Showing', 'staged changes');
    } else {
      ctx.output.keyValue('Showing', 'working directory changes');
    }
    ctx.output.newline();

    const rows: string[][] = [];
    let totalFiles = 0;
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (const module of modules) {
      const stats = await getModuleDiffStats(module.absolutePath, { staged, base: options.base });

      if (stats.filesChanged > 0) {
        totalFiles += stats.filesChanged;
        totalInsertions += stats.insertions;
        totalDeletions += stats.deletions;

        rows.push([
          ctx.output.module(module.name),
          String(stats.filesChanged),
          colors.success(`+${stats.insertions}`),
          colors.error(`-${stats.deletions}`),
        ]);
      }
    }

    if (rows.length === 0) {
      ctx.output.info('No changes found');
      return;
    }

    ctx.output.table(rows, {
      head: ['Module', 'Files', 'Insertions', 'Deletions'],
    });

    ctx.output.newline();
    ctx.output.info(
      `Total: ${totalFiles} files, ${colors.success(`+${totalInsertions}`)} ${colors.error(`-${totalDeletions}`)}`
    );
  } else {
    // Show full diff
    ctx.output.header('Diff');
    ctx.output.newline();

    for (const module of modules) {
      let cmd = 'git diff --color=always';
      if (staged) cmd += ' --staged';
      if (options.base) cmd += ` ${options.base}...HEAD`;

      try {
        const result = await exec(cmd, { cwd: module.absolutePath, silent: true });
        if (result.stdout?.trim()) {
          ctx.output.subheader(module.name);
          console.log(result.stdout);
        }
      } catch {
        // No diff or error, skip
      }
    }
  }
}

// ============================================================================
// Git Log - Show commits across modules
// ============================================================================

interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  module: string;
}

async function getModuleCommits(
  module: ResolvedModule,
  options: { maxCount?: string; since?: string; author?: string }
): Promise<CommitInfo[]> {
  try {
    const maxCount = options.maxCount ?? '5';
    let cmd = `git log --format="%H|%h|%an|%aI|%s" -n ${maxCount}`;
    if (options.since) cmd += ` --since="${options.since}"`;
    if (options.author) cmd += ` --author="${options.author}"`;

    const result = await exec(cmd, { cwd: module.absolutePath, silent: true });
    const lines = result.stdout?.trim().split('\n').filter(Boolean) ?? [];

    return lines.map((line) => {
      const [hash, shortHash, author, date, subject] = line.split('|');
      return { hash, shortHash, author, date, subject, module: module.name };
    });
  } catch {
    return [];
  }
}

async function gitLog(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { maxCount?: string; since?: string; author?: string; oneline?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  ctx.output.header('Git Log');
  if (options.since) ctx.output.keyValue('Since', options.since);
  if (options.author) ctx.output.keyValue('Author', options.author);
  ctx.output.newline();

  if (options.oneline) {
    // Collect all commits and sort by date
    const allCommits: CommitInfo[] = [];
    for (const module of modules) {
      const commits = await getModuleCommits(module, options);
      allCommits.push(...commits);
    }

    // Sort by date descending
    allCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Take top N overall
    const maxTotal = parseInt(options.maxCount ?? '20', 10);
    const topCommits = allCommits.slice(0, maxTotal);

    const rows: string[][] = topCommits.map((c) => [
      colors.muted(c.shortHash),
      ctx.output.module(c.module),
      c.subject.substring(0, 50) + (c.subject.length > 50 ? '...' : ''),
    ]);

    ctx.output.table(rows, {
      head: ['Commit', 'Module', 'Message'],
    });
  } else {
    // Show per-module
    for (const module of modules) {
      const commits = await getModuleCommits(module, options);

      if (commits.length > 0) {
        ctx.output.subheader(module.name);

        for (const commit of commits) {
          const date = new Date(commit.date).toLocaleDateString();
          console.log(
            `${colors.muted(commit.shortHash)} ${commit.subject}`
          );
          console.log(colors.muted(`  by ${commit.author} on ${date}`));
        }
        ctx.output.newline();
      }
    }
  }
}

// ============================================================================
// Git Changelog - Generate changelog from commits
// ============================================================================

interface ChangelogEntry {
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'other';
  scope?: string;
  subject: string;
  hash: string;
  module: string;
}

function parseConventionalCommit(subject: string): { type: string; scope?: string; message: string } {
  // Parse: "feat(scope): message" or "fix: message"
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?\s*:\s*(.+)$/);
  if (match) {
    return { type: match[1], scope: match[2], message: match[3] };
  }
  return { type: 'other', message: subject };
}

async function gitChangelog(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { since?: string; until?: string; format?: string } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);
  const since = options.since ?? 'HEAD~20';
  const until = options.until ?? 'HEAD';

  // Collect all commits
  const entries: ChangelogEntry[] = [];

  for (const module of modules) {
    try {
      const cmd = `git log --format="%H|%s" ${since}..${until}`;
      const result = await exec(cmd, { cwd: module.absolutePath, silent: true });
      const lines = result.stdout?.trim().split('\n').filter(Boolean) ?? [];

      for (const line of lines) {
        const [hash, ...subjectParts] = line.split('|');
        const subject = subjectParts.join('|');
        const parsed = parseConventionalCommit(subject);

        entries.push({
          type: parsed.type as ChangelogEntry['type'],
          scope: parsed.scope,
          subject: parsed.message,
          hash: hash.substring(0, 7),
          module: module.name,
        });
      }
    } catch {
      // No commits in range
    }
  }

  if (entries.length === 0) {
    ctx.output.info('No commits found in range');
    return;
  }

  // Group by type
  const grouped: Record<string, ChangelogEntry[]> = {};
  for (const entry of entries) {
    const type = entry.type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(entry);
  }

  // Output
  const isMarkdown = options.format === 'markdown';
  const typeLabels: Record<string, string> = {
    feat: '✨ Features',
    fix: '🐛 Bug Fixes',
    docs: '📚 Documentation',
    refactor: '♻️ Refactoring',
    test: '🧪 Tests',
    chore: '🔧 Chores',
    other: '📝 Other Changes',
  };

  if (isMarkdown) {
    console.log(`# Changelog\n`);
    console.log(`Changes from \`${since}\` to \`${until}\`\n`);

    for (const [type, label] of Object.entries(typeLabels)) {
      const typeEntries = grouped[type];
      if (!typeEntries || typeEntries.length === 0) continue;

      console.log(`## ${label}\n`);
      for (const entry of typeEntries) {
        const scope = entry.scope ? `**${entry.scope}:** ` : '';
        console.log(`- ${scope}${entry.subject} (\`${entry.hash}\` in ${entry.module})`);
      }
      console.log('');
    }
  } else {
    ctx.output.header('Changelog');
    ctx.output.keyValue('Range', `${since}..${until}`);
    ctx.output.newline();

    for (const [type, label] of Object.entries(typeLabels)) {
      const typeEntries = grouped[type];
      if (!typeEntries || typeEntries.length === 0) continue;

      ctx.output.subheader(label);
      for (const entry of typeEntries) {
        const scope = entry.scope ? `[${entry.scope}] ` : '';
        ctx.output.item(`${scope}${entry.subject} (${entry.hash} in ${entry.module})`);
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Total: ${entries.length} commits across ${modules.length} modules`);
}

// ============================================================================
// Git Graph - Visual branch overview across modules
// ============================================================================

interface BranchInfo {
  name: string;
  commit: string;
  date: string;
  isCurrent: boolean;
  isRemote: boolean;
}

async function getModuleBranches(module: ResolvedModule, showAll: boolean): Promise<BranchInfo[]> {
  try {
    const currentBranch = await getGitBranch(module.absolutePath);

    // Get local branches
    const localResult = await exec(
      'git for-each-ref --sort=-committerdate refs/heads --format="%(refname:short)|%(objectname:short)|%(committerdate:iso)"',
      { cwd: module.absolutePath, silent: true }
    );

    const branches: BranchInfo[] = [];

    for (const line of localResult.stdout?.trim().split('\n').filter(Boolean) ?? []) {
      const [name, commit, date] = line.split('|');
      branches.push({
        name,
        commit,
        date,
        isCurrent: name === currentBranch,
        isRemote: false,
      });
    }

    // Get remote branches if --all
    if (showAll) {
      const remoteResult = await exec(
        'git for-each-ref --sort=-committerdate refs/remotes/origin --format="%(refname:short)|%(objectname:short)|%(committerdate:iso)"',
        { cwd: module.absolutePath, silent: true }
      );

      for (const line of remoteResult.stdout?.trim().split('\n').filter(Boolean) ?? []) {
        const [name, commit, date] = line.split('|');
        // Skip HEAD pointer and branches we already have locally
        if (name.includes('HEAD')) continue;
        const localName = name.replace('origin/', '');
        if (branches.some((b) => b.name === localName)) continue;

        branches.push({
          name,
          commit,
          date,
          isCurrent: false,
          isRemote: true,
        });
      }
    }

    return branches;
  } catch {
    return [];
  }
}

async function gitGraph(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { maxCount?: string; all?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  ctx.output.header('Branch Graph');
  ctx.output.newline();

  // Create a timeline view showing all modules side by side
  const moduleData: Array<{ module: ResolvedModule; branches: BranchInfo[]; graph: string }> = [];

  for (const module of modules) {
    const branches = await getModuleBranches(module, options.all ?? false);

    // Get graph output
    const maxCount = options.maxCount ?? '10';
    let graphCmd = `git log --oneline --decorate --graph -n ${maxCount}`;
    if (options.all) graphCmd += ' --all';

    try {
      const graphResult = await exec(graphCmd, { cwd: module.absolutePath, silent: true });
      moduleData.push({
        module,
        branches,
        graph: graphResult.stdout?.trim() ?? '',
      });
    } catch {
      moduleData.push({
        module,
        branches,
        graph: '',
      });
    }
  }

  // Display each module's graph
  for (const data of moduleData) {
    const { module, branches, graph } = data;

    // Header with current branch highlighted
    const currentBranch = branches.find((b) => b.isCurrent);
    const branchDisplay = currentBranch
      ? colors.branch(currentBranch.name)
      : colors.muted('(detached)');

    ctx.output.subheader(`${module.name} [${branchDisplay}]`);

    // Show branches summary
    if (branches.length > 0) {
      const branchNames = branches
        .slice(0, 5)
        .map((b) => {
          let name = b.name;
          if (b.isCurrent) name = colors.success(`* ${name}`);
          else if (b.isRemote) name = colors.muted(name);
          else name = colors.primary(name);
          return name;
        })
        .join(', ');

      const moreCount = branches.length > 5 ? ` (+${branches.length - 5} more)` : '';
      ctx.output.muted(`  Branches: ${branchNames}${moreCount}`);
    }

    // Show graph
    if (graph) {
      console.log(graph.split('\n').map((line) => `  ${line}`).join('\n'));
    }

    ctx.output.newline();
  }

  // Summary table
  ctx.output.subheader('Summary');

  const rows: string[][] = [];
  for (const data of moduleData) {
    const currentBranch = data.branches.find((b) => b.isCurrent);
    const commit = currentBranch?.commit ?? 'N/A';
    const branchCount = data.branches.filter((b) => !b.isRemote).length;
    const remoteBranchCount = data.branches.filter((b) => b.isRemote).length;

    rows.push([
      ctx.output.module(data.module.name),
      colors.branch(currentBranch?.name ?? 'N/A'),
      colors.muted(commit),
      String(branchCount),
      String(remoteBranchCount),
    ]);
  }

  ctx.output.table(rows, {
    head: ['Module', 'Current Branch', 'Commit', 'Local', 'Remote'],
  });
}

// ============================================================================
// Git Stash - Multi-module stash operations
// ============================================================================

async function gitStashSave(
  ctx: IExecutionContext,
  message: string | undefined,
  moduleRefs: string[],
  options: { includeUntracked?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  // Filter to only modules with changes
  const modulesWithChanges: ResolvedModule[] = [];
  for (const module of modules) {
    const status = await getGitStatus(module.absolutePath);
    if (!status.clean) {
      modulesWithChanges.push(module);
    }
  }

  if (modulesWithChanges.length === 0) {
    ctx.output.info('No modules have uncommitted changes to stash');
    return;
  }

  const stashMessage = message ?? `jic-stash-${new Date().toISOString().split('T')[0]}`;

  ctx.output.header('Git Stash Save');
  ctx.output.keyValue('Message', stashMessage);
  ctx.output.keyValue('Modules', modulesWithChanges.length.toString());
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of modulesWithChanges) {
    const spinner = ctx.output.spinner(`${module.name}: stashing`);
    spinner.start();

    try {
      let cmd = `git stash push -m "${stashMessage}"`;
      if (options.includeUntracked) cmd += ' -u';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: stashed`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: stash failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;
    }
  }

  ctx.output.newline();
  ctx.output.info(`Stash complete: ${success} succeeded, ${failed} failed`);

  // Stash root repo for submodules projects
  if (ctx.isSubmodules() && !ctx.dryRun) {
    try {
      const { stdout: rootStatus } = await gitInRoot(ctx.projectRoot, ['status', '--porcelain']);
      if (rootStatus.trim()) {
        await gitInRoot(ctx.projectRoot, ['stash', 'push', '-m', stashMessage]);
        ctx.output.log('  Root repo: stashed');
      }
    } catch { /* nothing to stash */ }
  }
}

async function gitStashPop(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  // Pop root repo stash first for submodules projects
  if (ctx.isSubmodules() && !ctx.dryRun) {
    try {
      await gitInRoot(ctx.projectRoot, ['stash', 'pop']);
      ctx.output.log('  Root repo: stash popped');
    } catch { /* no stash */ }
  }

  // Filter to only modules with stashes
  const modulesWithStashes: ResolvedModule[] = [];
  for (const module of modules) {
    try {
      const result = await exec('git stash list', { cwd: module.absolutePath, silent: true });
      if (result.stdout?.trim()) {
        modulesWithStashes.push(module);
      }
    } catch {
      // No stashes
    }
  }

  if (modulesWithStashes.length === 0) {
    ctx.output.info('No modules have stashes to pop');
    return;
  }

  ctx.output.header('Git Stash Pop');
  ctx.output.keyValue('Modules', modulesWithStashes.length.toString());
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of modulesWithStashes) {
    const spinner = ctx.output.spinner(`${module.name}: popping stash`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] git stash pop`);
        success++;
        continue;
      }

      await exec('git stash pop', { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: stash popped`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: pop failed (conflict?)`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;
    }
  }

  ctx.output.newline();
  ctx.output.info(`Stash pop complete: ${success} succeeded, ${failed} failed`);
}

async function gitStashList(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  ctx.output.header('Git Stash List');
  ctx.output.newline();

  let hasStashes = false;

  for (const module of modules) {
    try {
      const result = await exec('git stash list', { cwd: module.absolutePath, silent: true });
      const stashes = result.stdout?.trim();

      if (stashes) {
        hasStashes = true;
        ctx.output.subheader(module.name);
        for (const line of stashes.split('\n')) {
          const match = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
          if (match) {
            console.log(`  ${colors.muted(match[1])} ${match[2]}`);
          } else {
            console.log(`  ${line}`);
          }
        }
        ctx.output.newline();
      }
    } catch {
      // No stashes or error
    }
  }

  if (!hasStashes) {
    ctx.output.info('No stashes found in any module');
  }
}

async function gitStashDrop(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { all?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);

  ctx.output.header('Git Stash Drop');
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    try {
      const result = await exec('git stash list', { cwd: module.absolutePath, silent: true });
      if (!result.stdout?.trim()) continue;

      const spinner = ctx.output.spinner(`${module.name}: dropping stash`);
      spinner.start();

      const cmd = options.all ? 'git stash clear' : 'git stash drop';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        success++;
        continue;
      }

      await exec(cmd, { cwd: module.absolutePath, silent: true });
      spinner.succeed(`${module.name}: stash dropped`);
      success++;
    } catch (error) {
      failed++;
    }
  }

  if (success === 0 && failed === 0) {
    ctx.output.info('No stashes to drop');
  } else {
    ctx.output.info(`Stash drop complete: ${success} succeeded, ${failed} failed`);
  }
}

// ============================================================================
// Git Sync - Sync current branch with base branch
// ============================================================================

async function gitSync(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: { merge?: boolean; base?: string; pull?: boolean } & GitGlobalOptions
): Promise<void> {
  const modules = resolveGitModules(ctx, moduleRefs, options);
  const useMerge = options.merge ?? false;
  const skipPull = options.pull === false;

  ctx.output.header('Git Sync');
  ctx.output.keyValue('Strategy', useMerge ? 'merge' : 'rebase');
  ctx.output.newline();

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const module of modules) {
    // Determine base branch for this module
    // Use local default branch (not main/master) as the base
    const baseBranch = options.base ??
      module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    const currentBranch = await getGitBranch(module.absolutePath);

    // Skip if already on base branch
    if (currentBranch === baseBranch || currentBranch === baseBranch.replace('origin/', '')) {
      ctx.output.muted(`${module.name}: already on base branch, skipping`);
      skipped++;
      continue;
    }

    const spinner = ctx.output.spinner(`${module.name}: syncing with ${baseBranch}`);
    spinner.start();

    try {
      // Check for uncommitted changes
      const status = await getGitStatus(module.absolutePath);
      if (!status.clean) {
        spinner.warn(`${module.name}: has uncommitted changes, skipping`);
        skipped++;
        continue;
      }

      if (ctx.dryRun) {
        const strategy = useMerge ? 'merge' : 'rebase';
        spinner.info(`${module.name}: [dry-run] would ${strategy} from ${baseBranch}`);
        success++;
        continue;
      }

      // Fetch latest if pulling is not skipped
      if (!skipPull) {
        await exec('git fetch origin', { cwd: module.absolutePath, silent: true });

        // Pull the base branch first to ensure it's up to date
        const currentOnBase = currentBranch === baseBranch;
        if (!currentOnBase) {
          // Checkout base branch, pull, then checkout back
          const checkoutResult = await exec(`git checkout ${baseBranch}`, {
            cwd: module.absolutePath,
            silent: true,
          });
          if (checkoutResult.success) {
            await exec('git pull', { cwd: module.absolutePath, silent: true });
            await exec(`git checkout ${currentBranch}`, { cwd: module.absolutePath, silent: true });
          }
        }
      }

      // Sync using merge or rebase
      if (useMerge) {
        await exec(`git merge ${baseBranch} --no-edit`, {
          cwd: module.absolutePath,
          silent: true,
        });
      } else {
        await exec(`git rebase ${baseBranch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
      }

      spinner.succeed(`${module.name}: synced with ${baseBranch}`);
      success++;
    } catch (error) {
      spinner.fail(`${module.name}: sync failed (conflict?)`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }

      // Abort if rebase/merge failed
      try {
        if (useMerge) {
          await exec('git merge --abort', { cwd: module.absolutePath, silent: true });
        } else {
          await exec('git rebase --abort', { cwd: module.absolutePath, silent: true });
        }
      } catch {
        // Already clean
      }

      failed++;

      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Sync failed for ${module.name}`, { moduleName: module.name });
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Sync complete: ${success} succeeded, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    ctx.output.warning('Some modules failed to sync. Resolve conflicts manually and retry.');
  }
}

// ============================================================================
// Git Commit - Quick commit in session modules
// ============================================================================

async function gitCommit(
  ctx: IExecutionContext,
  options: { message?: string; amend?: boolean; updateRoot?: boolean }
): Promise<void> {
  // Check if there's an active session
  if (!ctx.isSessionActive()) {
    throw new GitError('No active session. The commit command only works inside a session.');
  }

  const session = ctx.activeSession!;
  const modules = Object.keys(session.modules)
    .map((name) => ctx.getModule(name))
    .filter((m): m is ResolvedModule => m !== null);

  if (modules.length === 0) {
    ctx.output.warning('No modules in session');
    return;
  }

  // Determine commit message
  const commitMessage = options.message ?? session.description ?? `Session ${session.name} commit`;

  ctx.output.header('Git Commit');
  ctx.output.keyValue('Message', commitMessage);
  ctx.output.keyValue('Session', session.name);
  ctx.output.newline();

  let committed = 0;
  let skipped = 0;
  let failed = 0;

  for (const module of modules) {
    const status = await getGitStatus(module.absolutePath);

    // Skip if no changes
    if (status.clean) {
      ctx.output.muted(`${module.name}: no changes`);
      skipped++;
      continue;
    }

    const spinner = ctx.output.spinner(`${module.name}: committing`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would add and commit changes`);
        committed++;
        continue;
      }

      // Add all changes (tracked and untracked)
      const addResult = await exec('git add -A', {
        cwd: module.absolutePath,
        silent: true,
      });

      if (!addResult.success) {
        spinner.fail(`${module.name}: failed to add files`);
        if (addResult.stderr) {
          ctx.output.error(`  ${addResult.stderr}`);
        }
        failed++;
        continue;
      }

      // Commit
      let commitCmd = `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`;
      if (options.amend) {
        commitCmd = `git commit --amend -m "${commitMessage.replace(/"/g, '\\"')}"`;
      }

      const commitResult = await exec(commitCmd, {
        cwd: module.absolutePath,
        silent: true,
      });

      if (!commitResult.success) {
        spinner.fail(`${module.name}: commit failed`);
        if (commitResult.stderr) {
          ctx.output.error(`  ${commitResult.stderr}`);
        }
        failed++;
        continue;
      }

      // Get the new commit hash
      const newCommit = await getGitCommit(module.absolutePath);
      spinner.succeed(`${module.name}: committed (${newCommit?.substring(0, 7) ?? 'unknown'})`);
      committed++;
    } catch (error) {
      spinner.fail(`${module.name}: commit failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
      failed++;
    }
  }

  ctx.output.newline();
  ctx.output.info(`Commit complete: ${committed} committed, ${skipped} skipped, ${failed} failed`);

  if (committed > 0) {
    ctx.output.info('Use "jic git push" to push changes to remote');
  }

  // Update root repo submodule pointers if requested
  if (options.updateRoot && ctx.isSubmodules() && committed > 0 && !ctx.dryRun) {
    ctx.output.newline();
    const spinner = ctx.output.spinner('Updating submodule pointers in root repo');
    spinner.start();
    try {
      const modulePaths = modules.map((m) => m.directory);
      await stageSubmodulePointers(ctx.projectRoot, modulePaths);
      await commitSubmodulePointers(ctx.projectRoot, modules.map((m) => m.name));
      spinner.succeed('Submodule pointers updated in root repo');
    } catch (error) {
      spinner.fail('Failed to update submodule pointers');
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }
}

// ============================================================================
// Export stash functions for session pause
// ============================================================================

export { gitStashSave, gitStashPop };
