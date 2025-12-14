/**
 * Git commands for multi-module operations
 *
 * Commands:
 *   jic git status [modules...]
 *   jic git checkout <branch> [modules...]
 *   jic git branch create <name> [--from <base>] [modules...]
 *   jic git branch delete <name> [modules...]
 *   jic git merge <source> [--into <target>] [modules...]
 *   jic git rebase <base> [modules...]
 *   jic git fetch [modules...]
 *   jic git pull [modules...]
 *   jic git push [modules...]
 *   jic git foreach <command>
 */

import { withErrorHandling, GitError } from '../utils/error.js';
import { exec, execInModule, getGitBranch, getGitStatus, getGitCommit } from '../utils/shell.js';
import { output, formatModuleStatus, createSpinner } from '../utils/output.js';

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
    .action(withErrorHandling(async (branch, modules, options) => {
      await gitCheckout(ctx, branch, modules, options);
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
    .description('Delete a branch in modules')
    .argument('[modules...]', 'Modules to delete branch from')
    .option('-f, --force', 'Force delete')
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
    .action(withErrorHandling(async (source, modules, options) => {
      await gitMerge(ctx, source, modules, options);
    }));

  // Rebase command
  git
    .command('rebase <base>')
    .description('Rebase current branch onto base')
    .argument('[modules...]', 'Modules to rebase')
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
 */
async function gitCheckout(ctx, branch, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Checkout: ${branch}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: checking out ${branch}`);
    spinner.start();

    try {
      // Check if branch exists
      const branchExists = await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd: module.absolutePath,
        silent: true
      }).then(() => true).catch(() => false);

      let cmd;
      if (branchExists) {
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
          spinner.fail(`${module.name}: branch '${branch}' does not exist`);
          continue;
        }
      }

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: ${branch}`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Failed to checkout ${branch} in ${module.name}`, module.name);
      }
    }
  }
}

/**
 * Create branch in modules
 */
async function gitBranchCreate(ctx, name, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Create Branch: ${name}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: creating ${name}`);
    spinner.start();

    try {
      // Determine base branch
      let base = options.from;
      if (base === 'HEAD') {
        // Use module's configured local branch or current branch
        base = module.branches?.local || await getGitBranch(module.absolutePath);
      }

      // First checkout base, then create new branch
      const cmd = `git checkout ${base} && git checkout -b ${name}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: ${name} (from ${base})`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Failed to create branch in ${module.name}`, module.name);
      }
    }
  }
}

/**
 * Delete branch in modules
 */
async function gitBranchDelete(ctx, name, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Delete Branch: ${name}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: deleting ${name}`);
    spinner.start();

    try {
      const flag = options.force ? '-D' : '-d';
      const cmd = `git branch ${flag} ${name}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: deleted ${name}`);
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Failed to delete branch in ${module.name}`, module.name);
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
 */
async function gitMerge(ctx, source, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Merge: ${source}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: merging ${source}`);
    spinner.start();

    try {
      // Checkout target if specified
      if (options.into) {
        await execInModule(module, `git checkout ${options.into}`, { silent: true });
      }

      const flags = [];
      if (options.noFf) flags.push('--no-ff');
      if (options.message) flags.push(`-m "${options.message}"`);
      else flags.push('--no-edit');

      const cmd = `git merge ${source} ${flags.join(' ')}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: merged ${source}`);
    } catch (error) {
      spinner.fail(`${module.name}: merge conflict or error`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Merge failed in ${module.name}`, module.name);
      }
    }
  }
}

/**
 * Rebase branch in modules
 */
async function gitRebase(ctx, base, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

  output.header(`Rebase onto: ${base}`);

  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: rebasing onto ${base}`);
    spinner.start();

    try {
      const cmd = `git rebase ${base}`;

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cmd}`);
        continue;
      }

      await execInModule(module, cmd, { silent: true });
      spinner.succeed(`${module.name}: rebased onto ${base}`);
    } catch (error) {
      spinner.fail(`${module.name}: rebase conflict or error`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new GitError(`Rebase failed in ${module.name}`, module.name);
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
        throw new GitError(`Pull failed in ${module.name}`, module.name);
      }
    }
  }
}

/**
 * Push to remote
 */
async function gitPush(ctx, moduleRefs, options) {
  const modules = ctx.resolveModules(moduleRefs);

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
        throw new GitError(`Push failed in ${module.name}`, module.name);
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
        throw new GitError(`Command failed in ${module.name}`, module.name);
      }
    }
  }
}

export default { registerGitCommands };
