/**
 * Git commands for multi-module operations
 *
 * Commands:
 *   jic git status [modules...]
 *   jic git checkout <branch> [modules...]
 *   jic git search <branch> - Find modules where branch exists
 *   jic git branch create <name> [--from <base>] [modules...]
 *   jic git branch delete <name> [--remote] [--yes] [modules...]
 *   jic git merge <source> [--into <target>] [modules...]
 *   jic git rebase <base> [modules...]
 *   jic git fetch [modules...]
 *   jic git pull [modules...]
 *   jic git push [modules...]
 *   jic git foreach <command>
 */

import inquirer from 'inquirer';
import { withErrorHandling, GitError } from '../utils/error.js';
import { exec, execInModule, getGitBranch, getGitStatus, getGitCommit } from '../utils/shell.js';
import { output, formatModuleStatus, createSpinner } from '../utils/output.js';

/**
 * Check if a branch exists locally or remotely
 */
async function branchExists(module, branch) {
  const localExists = await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
    cwd: module.absolutePath,
    silent: true
  }).then(() => true).catch(() => false);

  const remoteExists = await exec(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, {
    cwd: module.absolutePath,
    silent: true
  }).then(() => true).catch(() => false);

  return { localExists, remoteExists, exists: localExists || remoteExists };
}

/**
 * Get detailed uncommitted changes info
 * Returns { hasChanges: boolean, staged: string[], unstaged: string[], untracked: string[] }
 */
async function getUncommittedChanges(module) {
  try {
    const result = await exec('git status --porcelain', {
      cwd: module.absolutePath,
      silent: true
    });

    const lines = result.stdout.trim().split('\n').filter(Boolean);

    const staged = [];      // Changes in staging area (index)
    const unstaged = [];    // Modified but not staged
    const untracked = [];   // New files not tracked

    for (const line of lines) {
      const indexStatus = line[0];   // Status in staging area
      const workStatus = line[1];    // Status in working tree
      const file = line.substring(3);

      // Untracked files
      if (indexStatus === '?' && workStatus === '?') {
        untracked.push(file);
      }
      // Staged changes (added, modified, deleted in index)
      else if (indexStatus !== ' ' && indexStatus !== '?') {
        staged.push(`${indexStatus} ${file}`);
      }
      // Unstaged changes (modified, deleted in working tree)
      if (workStatus !== ' ' && workStatus !== '?') {
        unstaged.push(`${workStatus} ${file}`);
      }
    }

    return {
      hasChanges: lines.length > 0,
      staged,
      unstaged,
      untracked,
      total: lines.length
    };
  } catch {
    return { hasChanges: false, staged: [], unstaged: [], untracked: [], total: 0 };
  }
}

/**
 * Format uncommitted files for display with categories
 */
function formatUncommittedFiles(changes, maxFiles = 20) {
  if (!changes.hasChanges) return '';

  const lines = [];

  if (changes.staged.length > 0) {
    lines.push(output.colors.success('    Staged (ready to commit):'));
    const show = changes.staged.slice(0, maxFiles);
    show.forEach(f => lines.push(`      ${f}`));
    if (changes.staged.length > maxFiles) {
      lines.push(`      ... and ${changes.staged.length - maxFiles} more`);
    }
  }

  if (changes.unstaged.length > 0) {
    lines.push(output.colors.warning('    Unstaged (not staged for commit):'));
    const show = changes.unstaged.slice(0, maxFiles);
    show.forEach(f => lines.push(`      ${f}`));
    if (changes.unstaged.length > maxFiles) {
      lines.push(`      ... and ${changes.unstaged.length - maxFiles} more`);
    }
  }

  if (changes.untracked.length > 0) {
    lines.push(output.colors.muted('    Untracked (new files):'));
    const show = changes.untracked.slice(0, maxFiles);
    show.forEach(f => lines.push(`      ${f}`));
    if (changes.untracked.length > maxFiles) {
      lines.push(`      ... and ${changes.untracked.length - maxFiles} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if source branch is already merged into current branch
 */
async function isBranchMerged(module, source) {
  try {
    const result = await exec(`git branch --merged`, {
      cwd: module.absolutePath,
      silent: true
    });
    const mergedBranches = result.stdout.split('\n').map(b => b.trim().replace('* ', ''));
    return mergedBranches.includes(source);
  } catch {
    return false;
  }
}

/**
 * Protected branch names that should trigger warnings
 */
const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'production', 'prod'];

/**
 * Register git commands
 */
export function registerGitCommands(program, ctx) {
  const git = program
    .command('git')
    .description('Git operations across submodules');

  // Status command
  git
    .command('status')
    .description('Show git status across modules')
    .argument('[modules...]', 'Modules to check (default: all)')
    .option('-s, --short', 'Short format')
    .action(withErrorHandling(async (modules, options) => {
      await gitStatus(ctx, modules, options);
    }));

  // Checkout command
  git
    .command('checkout <branch>')
    .description('Checkout branch in modules')
    .argument('[modules...]', 'Modules to checkout (default: all)')
    .option('-b, --create', 'Create branch if it does not exist')
    .option('--from <base>', 'Base branch for new branch', 'HEAD')
    .option('-f, --force', 'Force checkout even with uncommitted changes')
    .action(withErrorHandling(async (branch, modules, options) => {
      await gitCheckout(ctx, branch, modules, options);
    }));

  // Search command - find modules where a branch exists
  git
    .command('search <branch>')
    .description('Find modules where a branch exists')
    .option('-l, --local', 'Search only local branches')
    .option('-r, --remote', 'Search only remote branches')
    .action(withErrorHandling(async (branch, options) => {
      await gitSearch(ctx, branch, options);
    }));

  // Branch subcommand
  const branch = git
    .command('branch')
    .description('Branch operations');

  branch
    .command('create <name>')
    .description('Create a new branch in modules')
    .argument('[modules...]', 'Modules to create branch in')
    .option('--from <base>', 'Base branch', 'HEAD')
    .action(withErrorHandling(async (name, modules, options) => {
      await gitBranchCreate(ctx, name, modules, options);
    }));

  branch
    .command('delete <name>')
    .description('Delete a branch in modules where it exists')
    .argument('[modules...]', 'Modules to delete branch from (default: all where branch exists)')
    .option('-f, --force', 'Force delete unmerged branches')
    .option('-r, --remote', 'Also delete remote branch')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(withErrorHandling(async (name, modules, options) => {
      await gitBranchDelete(ctx, name, modules, options);
    }));

  branch
    .command('list')
    .description('List branches in modules')
    .argument('[modules...]', 'Modules to list branches')
    .option('-a, --all', 'List remote branches too')
    .action(withErrorHandling(async (modules, options) => {
      await gitBranchList(ctx, modules, options);
    }));

  // Merge command
  git
    .command('merge <source>')
    .description('Merge branch into current branch')
    .argument('[modules...]', 'Modules to merge in')
    .option('--into <target>', 'Target branch (default: current)')
    .option('--no-ff', 'Create merge commit even for fast-forward')
    .option('-m, --message <msg>', 'Merge commit message')
    .option('-f, --force', 'Force merge even with uncommitted changes')
    .action(withErrorHandling(async (source, modules, options) => {
      await gitMerge(ctx, source, modules, options);
    }));

  // Rebase command
  git
    .command('rebase <base>')
    .description('Rebase current branch onto base')
    .argument('[modules...]', 'Modules to rebase')
    .option('-f, --force', 'Force rebase even with uncommitted changes')
    .action(withErrorHandling(async (base, modules, options) => {
      await gitRebase(ctx, base, modules, options);
    }));

  // Fetch command
  git
    .command('fetch')
    .description('Fetch from remotes')
    .argument('[modules...]', 'Modules to fetch')
    .option('-p, --prune', 'Prune deleted remote branches')
    .action(withErrorHandling(async (modules, options) => {
      await gitFetch(ctx, modules, options);
    }));

  // Pull command
  git
    .command('pull')
    .description('Pull current branch from remote')
    .argument('[modules...]', 'Modules to pull')
    .option('-r, --rebase', 'Rebase instead of merge')
    .action(withErrorHandling(async (modules, options) => {
      await gitPull(ctx, modules, options);
    }));

  // Push command
  git
    .command('push')
    .description('Push current branch to remote')
    .argument('[modules...]', 'Modules to push')
    .option('-f, --force', 'Force push')
    .option('-u, --set-upstream', 'Set upstream tracking')
    .option('-y, --yes', 'Skip confirmation for protected branches')
    .action(withErrorHandling(async (modules, options) => {
      await gitPush(ctx, modules, options);
    }));

  // Foreach command
  git
    .command('foreach <command>')
    .description('Run git command in each module')
    .argument('[modules...]', 'Modules to run in')
    .action(withErrorHandling(async (command, modules) => {
      await gitForeach(ctx, command, modules);
    }));
}

/**
 * Show git status across modules
 */
async function gitStatus(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  if (ctx.json) {
    const statuses = await Promise.all(modules.map(async m => ({
      name: m.name,
      directory: m.directory,
      branch: await getGitBranch(m.absolutePath),
      status: await getGitStatus(m.absolutePath),
      commit: await getGitCommit(m.absolutePath)
    })));
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  output.header('Git Status');

  const results = [];

  for (const module of modules) {
    const branch = await getGitBranch(module.absolutePath);
    const status = await getGitStatus(module.absolutePath);
    const commit = await getGitCommit(module.absolutePath);

    let statusStr = '';
    if (status.clean) {
      statusStr = output.colors.success('clean');
    } else {
      const parts = [];
      if (status.modified) parts.push(output.colors.warning(`${status.modified}M`));
      if (status.added) parts.push(output.colors.success(`${status.added}A`));
      if (status.deleted) parts.push(output.colors.error(`${status.deleted}D`));
      statusStr = parts.join(' ');
    }

    results.push([
      output.module(module.name),
      output.colors.primary(branch || 'N/A'),
      output.colors.muted(commit || 'N/A'),
      statusStr
    ]);
  }

  output.table(results, {
    head: ['Module', 'Branch', 'Commit', 'Status']
  });
}

/**
 * Checkout branch in modules
 *
 * Behavior:
 * - If branch exists locally or remotely: checkout that branch
 * - If branch doesn't exist and -b flag: create the branch
 * - If branch doesn't exist and no -b flag: fallback to module's default local branch
 */
async function gitCheckout(ctx, branch, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Checkout: ${branch}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: checking out ${branch}`);
    spinner.start();

    try {
      // Check for uncommitted changes (skip check if --force)
      if (!options.force) {
        const changes = await getUncommittedChanges(module);
        if (changes.hasChanges) {
          spinner.warn(`${module.name}: has uncommitted changes, skipping (use --force to override)`);
          console.log(formatUncommittedFiles(changes));
          continue;
        }
      }

      // Check if branch exists locally
      const localBranchExists = await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd: module.absolutePath,
        silent: true
      }).then(() => true).catch(() => false);

      let cmd;
      let targetBranch = branch;
      let fallback = false;

      if (localBranchExists) {
        cmd = `git checkout ${branch}`;
      } else if (options.create) {
        cmd = `git checkout -b ${branch} ${options.from}`;
      } else {
        // Try to checkout from remote
        const remoteExists = await exec(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, {
          cwd: module.absolutePath,
          silent: true
        }).then(() => true).catch(() => false);

        if (remoteExists) {
          cmd = `git checkout -b ${branch} origin/${branch}`;
        } else {
          // Fallback to module's default local branch
          const defaultBranch = module.branches?.local;
          if (defaultBranch) {
            targetBranch = defaultBranch;
            fallback = true;

            // Check if default branch exists locally
            const defaultExists = await exec(`git show-ref --verify --quiet refs/heads/${defaultBranch}`, {
              cwd: module.absolutePath,
              silent: true
            }).then(() => true).catch(() => false);

            if (defaultExists) {
              cmd = `git checkout ${defaultBranch}`;
            } else {
              // Try default branch from remote
              const defaultRemoteExists = await exec(`git show-ref --verify --quiet refs/remotes/origin/${defaultBranch}`, {
                cwd: module.absolutePath,
                silent: true
              }).then(() => true).catch(() => false);

              if (defaultRemoteExists) {
                cmd = `git checkout -b ${defaultBranch} origin/${defaultBranch}`;
              } else {
                spinner.fail(`${module.name}: neither '${branch}' nor default '${defaultBranch}' exist`);
                continue;
              }
            }
          } else {
            spinner.fail(`${module.name}: branch '${branch}' does not exist and no default branch configured`);
            continue;
          }
        }
      }

      if (ctx.dryRun) {
        const msg = fallback
          ? `${module.name}: [dry-run] ${cmd} (fallback from ${branch})`
          : `${module.name}: [dry-run] ${cmd}`;
        spinner.info(msg);
        continue;
      }

      await execInModule(module, cmd, { silent: true });

      if (fallback) {
        spinner.warn(`${module.name}: ${targetBranch} (fallback, '${branch}' not found)`);
      } else {
        spinner.succeed(`${module.name}: ${targetBranch}`);
      }
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Failed to checkout ${branch} in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Search for modules where a branch exists
 */
async function gitSearch(ctx, branch, options) {
  const modules = ctx.resolveModules([]);

  output.header(`Search: ${branch}`);

  const results = [];

  for (const module of modules) {
    // Check local branch
    const localExists = await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
      cwd: module.absolutePath,
      silent: true
    }).then(() => true).catch(() => false);

    // Check remote branch
    const remoteExists = await exec(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, {
      cwd: module.absolutePath,
      silent: true
    }).then(() => true).catch(() => false);

    // Filter based on options
    const showLocal = !options.remote || options.local;
    const showRemote = !options.local || options.remote;

    if ((showLocal && localExists) || (showRemote && remoteExists)) {
      const locations = [];
      if (localExists && showLocal) locations.push(output.colors.success('local'));
      if (remoteExists && showRemote) locations.push(output.colors.primary('remote'));

      results.push([
        output.module(module.name),
        locations.join(', ')
      ]);
    }
  }

  if (results.length === 0) {
    output.info(`Branch '${branch}' not found in any module`);
  } else {
    output.table(results, {
      head: ['Module', 'Location']
    });
    output.newline();
    output.info(`Found in ${results.length} module(s)`);
  }
}

/**
 * Create branch in modules
 * Skips modules where base branch doesn't exist
 */
async function gitBranchCreate(ctx, name, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Create Branch: ${name}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: creating ${name}`);
    spinner.start();

    try {
      // Check if new branch already exists
      const newBranchCheck = await branchExists(module, name);
      if (newBranchCheck.exists) {
        spinner.warn(`${module.name}: branch '${name}' already exists`);
        continue;
      }

      // Determine base branch
      let base = options.from;
      if (base === 'HEAD') {
        // Use module's configured local branch or current branch
        base = module.branches?.local || await getGitBranch(module.absolutePath);
      }

      // Check if base branch exists locally or remotely
      const baseCheck = await branchExists(module, base);

      if (!baseCheck.exists) {
        spinner.warn(`${module.name}: skipped (base branch '${base}' not found)`);
        continue;
      }

      // Use origin/branch if only remote exists
      const checkoutBase = baseCheck.localExists ? base : `origin/${base}`;

      // First checkout base, then create new branch
      const cmd = `git checkout ${checkoutBase} && git checkout -b ${name}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: ${name} (from ${base})`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Failed to create branch in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Delete branch in modules
 * If no modules specified, finds all modules where the branch exists
 * Requires confirmation unless --yes is passed
 */
async function gitBranchDelete(ctx, name, moduleRefs, options) {
  // Get all modules or specified modules
  let modules = ctx.resolveModules(moduleRefs);

  // If no modules specified, find modules where branch exists
  const targetsWithInfo = [];

  for (const module of modules) {
    const check = await branchExists(module, name);
    const currentBranch = await getGitBranch(module.absolutePath);
    const isCurrentBranch = currentBranch === name;

    // If modules were explicitly specified, include them even if branch doesn't exist
    // Otherwise, only include modules where branch exists
    if (moduleRefs && moduleRefs.length > 0) {
      targetsWithInfo.push({ module, localExists: check.localExists, remoteExists: check.remoteExists, isCurrentBranch });
    } else if (check.exists) {
      targetsWithInfo.push({ module, localExists: check.localExists, remoteExists: check.remoteExists, isCurrentBranch });
    }
  }

  if (targetsWithInfo.length === 0) {
    output.info(`Branch '${name}' not found in any module`);
    return;
  }

  // Show what will be deleted
  output.header(`Delete Branch: ${name}`);
  output.newline();

  const deleteInfo = [];
  for (const { module, localExists, remoteExists, isCurrentBranch } of targetsWithInfo) {
    const actions = [];
    if (localExists && !isCurrentBranch) actions.push('local');
    if (localExists && isCurrentBranch) actions.push(output.colors.warning('local (current branch - will skip)'));
    if (options.remote && remoteExists) actions.push('remote');
    if (actions.length > 0) {
      deleteInfo.push([output.module(module.name), actions.join(', ')]);
    }
  }

  if (deleteInfo.length === 0) {
    output.info('Nothing to delete');
    return;
  }

  output.table(deleteInfo, {
    head: ['Module', 'Will Delete']
  });
  output.newline();

  // Confirm deletion unless --yes is passed or dry-run
  if (!options.yes && !ctx.dryRun) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Delete branch '${name}' from ${deleteInfo.length} module(s)?`,
      default: false
    }]);

    if (!confirm) {
      output.info('Aborted');
      return;
    }
  }

  // Perform deletion
  for (const { module, localExists, remoteExists, isCurrentBranch } of targetsWithInfo) {
    // Delete local branch (skip if it's the current branch)
    if (localExists && isCurrentBranch) {
      const spinner = createSpinner(`${module.name}: deleting local branch`);
      spinner.start();
      spinner.warn(`${module.name}: skipped (cannot delete current branch)`);
    } else if (localExists) {
      const spinner = createSpinner(`${module.name}: deleting local branch`);
      spinner.start();

      try {
        const flag = options.force ? '-D' : '-d';
        const cmd = `git branch ${flag} ${name}`;

        if (ctx.dryRun) {
          spinner.info(`${module.name}: [dry-run] ${cmd}`);
        } else {
          await execInModule(module, cmd, { silent: true });
          spinner.succeed(`${module.name}: deleted local`);
        }
      } catch (error) {
        spinner.fail(`${module.name}: ${error.stderr || error.message}`);
        if (ctx.failStrategy === 'fail-fast') {
          const gitError = new GitError(`Failed to delete local branch in ${module.name}`, module.name);
          gitError.cause = error;
          throw gitError;
        }
      }
    }

    // Delete remote branch if requested
    if (options.remote && remoteExists) {
      const spinner = createSpinner(`${module.name}: deleting remote branch`);
      spinner.start();

      try {
        const cmd = `git push origin --delete ${name}`;

        if (ctx.dryRun) {
          spinner.info(`${module.name}: [dry-run] ${cmd}`);
        } else {
          await execInModule(module, cmd, { silent: true });
          spinner.succeed(`${module.name}: deleted remote`);
        }
      } catch (error) {
        spinner.fail(`${module.name}: ${error.stderr || error.message}`);
        if (ctx.failStrategy === 'fail-fast') {
          const gitError = new GitError(`Failed to delete remote branch in ${module.name}`, module.name);
          gitError.cause = error;
          throw gitError;
        }
      }
    }
  }
}

/**
 * List branches in modules
 */
async function gitBranchList(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  for (const module of modules) {
    output.subheader(module.name);

    const flag = options.all ? '-a' : '';
    const result = await execInModule(module, `git branch ${flag}`, { silent: true });
    console.log(result.stdout);
  }
}

/**
 * Merge branch in modules
 * Skips modules where source branch doesn't exist
 */
async function gitMerge(ctx, source, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Merge: ${source}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: merging ${source}`);
    spinner.start();

    try {
      // Check for uncommitted changes (skip check if --force)
      if (!options.force) {
        const changes = await getUncommittedChanges(module);
        if (changes.hasChanges) {
          spinner.warn(`${module.name}: has uncommitted changes, skipping (use --force to override)`);
          console.log(formatUncommittedFiles(changes));
          continue;
        }
      }

      // Get current branch
      const currentBranch = await getGitBranch(module.absolutePath);

      // Check if trying to merge branch into itself
      if (currentBranch === source) {
        spinner.warn(`${module.name}: skipped (cannot merge branch into itself)`);
        continue;
      }

      // Check if source branch exists locally or remotely
      const sourceCheck = await branchExists(module, source);

      if (!sourceCheck.exists) {
        spinner.warn(`${module.name}: skipped (branch '${source}' not found)`);
        continue;
      }

      // Check if already merged
      if (await isBranchMerged(module, source)) {
        spinner.info(`${module.name}: already merged`);
        continue;
      }

      // Checkout target if specified
      if (options.into) {
        await execInModule(module, `git checkout ${options.into}`, { silent: true });
      }

      const flags = [];
      if (options.noFf) flags.push('--no-ff');
      if (options.message) flags.push(`-m "${options.message}"`);
      else flags.push('--no-edit');

      // Use origin/branch if only remote exists
      const mergeSource = sourceCheck.localExists ? source : `origin/${source}`;
      const cmd = `git merge ${mergeSource} ${flags.join(' ')}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: merged ${source}`);
    } catch (error) {
      spinner.fail(`${module.name}: merge conflict or error`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Merge failed in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Rebase branch in modules
 * Skips modules where base branch doesn't exist
 */
async function gitRebase(ctx, base, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Rebase onto: ${base}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: rebasing onto ${base}`);
    spinner.start();

    try {
      // Check for uncommitted changes (skip check if --force)
      if (!options.force) {
        const changes = await getUncommittedChanges(module);
        if (changes.hasChanges) {
          spinner.warn(`${module.name}: has uncommitted changes, skipping (use --force to override)`);
          console.log(formatUncommittedFiles(changes));
          continue;
        }
      }

      // Get current branch
      const currentBranch = await getGitBranch(module.absolutePath);

      // Check if trying to rebase onto itself
      if (currentBranch === base) {
        spinner.warn(`${module.name}: skipped (already on '${base}')`);
        continue;
      }

      // Check if base branch exists locally or remotely
      const baseCheck = await branchExists(module, base);

      if (!baseCheck.exists) {
        spinner.warn(`${module.name}: skipped (branch '${base}' not found)`);
        continue;
      }

      // Use origin/branch if only remote exists
      const rebaseBase = baseCheck.localExists ? base : `origin/${base}`;
      const cmd = `git rebase ${rebaseBase}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: rebased onto ${base}`);
    } catch (error) {
      spinner.fail(`${module.name}: rebase conflict or error`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Rebase failed in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Fetch from remotes
 */
async function gitFetch(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header('Fetch');

  const promises = modules.map(async module => {
    const spinner = createSpinner(`${module.name}: fetching`);
    spinner.start();

    try {
      const flags = options.prune ? '--prune' : '';
      const cmd = `git fetch ${flags}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        return;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: fetched`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
    }
  });

  await Promise.all(promises);
}

/**
 * Pull from remote
 */
async function gitPull(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header('Pull');

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: pulling`);
    spinner.start();

    try {
      const flags = options.rebase ? '--rebase' : '';
      const cmd = `git pull ${flags}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: pulled`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Pull failed in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Push to remote
 * Warns before pushing to protected branches
 */
async function gitPush(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  // Check for protected branches and warn
  const protectedModules = [];
  for (const module of modules) {
    const currentBranch = await getGitBranch(module.absolutePath);
    if (PROTECTED_BRANCHES.includes(currentBranch)) {
      protectedModules.push({ module, branch: currentBranch });
    }
  }

  // Warn about force push to protected branches
  if (options.force && protectedModules.length > 0) {
    output.warning('Force pushing to protected branches:');
    for (const { module, branch } of protectedModules) {
      output.warning(`  - ${module.name} (${branch})`);
    }
    output.newline();

    if (!options.yes && !ctx.dryRun) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Force push to protected branches? This is dangerous!',
        default: false
      }]);

      if (!confirm) {
        output.info('Aborted');
        return;
      }
    }
  }

  output.header('Push');

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: pushing`);
    spinner.start();

    try {
      const flags = [];
      if (options.force) flags.push('--force');
      if (options.setUpstream) flags.push('-u origin HEAD');

      const cmd = `git push ${flags.join(' ')}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: pushed`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Push failed in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

/**
 * Run git command in each module
 */
async function gitForeach(ctx, command, moduleRefs) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Git foreach: ${command}`);

  for (const module of modules) {
    output.subheader(module.name);

    try {
      const cmd = `git ${command}`;

      if (ctx.dryRun) {
        output.info(`[dry-run] ${cmd}`);
        continue;
      }

      const result = await execInModule(module, cmd, { silent: false });
      if (result.stdout) console.log(result.stdout);
    } catch (error) {
      output.error(`Error: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        const gitError = new GitError(`Command failed in ${module.name}`, module.name);
        gitError.cause = error;
        throw gitError;
      }
    }
  }
}

export default { registerGitCommands };
