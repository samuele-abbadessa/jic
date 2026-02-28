/**
 * Session Command
 *
 * Work session management for tracking work across multiple modules.
 *
 * Features:
 * - Auto-scoping: When session is active, commands filter to session modules
 * - Branch tracking: Track which branches are merged into session
 * - Templates: Pre-defined session configurations
 *
 * Examples:
 *   jic session start myFeature              # Start new session
 *   jic session start hotfix --template fix  # Use template
 *   jic session checkout                     # Checkout session branches
 *   jic session status                       # Show current session
 *   jic session end                          # End session
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ResolvedModule } from '../core/types/module.js';
import type { Session } from '../core/types/state.js';
import { SessionError, withErrorHandling } from '../core/errors/index.js';
import { exec, getGitBranch, getGitStatus, getGitCommit } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// Types
// ============================================================================

interface SessionTemplate {
  description: string;
  moduleGroups: string[];
  baseBranch: string;
  branchPrefix: string;
}

// Built-in session templates
const SESSION_TEMPLATES: Record<string, SessionTemplate> = {
  feature: {
    description: 'Feature development across backend and frontend',
    moduleGroups: ['@backend', '@frontend'],
    baseBranch: 'feature/samuele',
    branchPrefix: 'feature/',
  },
  hotfix: {
    description: 'Quick fix for production issues',
    moduleGroups: ['@backend', '@frontend'],
    baseBranch: 'master',
    branchPrefix: 'hotfix/',
  },
  api: {
    description: 'API changes requiring flux client updates',
    moduleGroups: ['@flux', '@backend'],
    baseBranch: 'feature/samuele',
    branchPrefix: 'feature/',
  },
  backend: {
    description: 'Backend-only changes',
    moduleGroups: ['@backend'],
    baseBranch: 'feature/samuele',
    branchPrefix: 'feature/',
  },
};

// ============================================================================
// Session Command Registration
// ============================================================================

export function registerSessionCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const session = program.command('session').description('Work session management');

  // Start session
  session
    .command('start <name>')
    .description('Start a new work session')
    .option('-m, --modules <modules...>', 'Modules to include')
    .option('-t, --template <template>', 'Use session template (feature, hotfix, api, backend)')
    .option('-b, --base <branch>', 'Base branch for session')
    .option('-d, --description <desc>', 'Session description')
    .option('--no-checkout', 'Skip branch checkout')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            modules?: string[];
            template?: string;
            base?: string;
            description?: string;
            checkout?: boolean;
          }
        ) => {
          const ctx = await createContext();
          await sessionStart(ctx, name, options);
        }
      )
    );

  // End session
  session
    .command('end [name]')
    .description('End a work session')
    .option('--merge', 'Merge session branches to base')
    .option('--delete-branches', 'Delete session branches after merge')
    .action(
      withErrorHandling(
        async (name: string | undefined, options: { merge?: boolean; deleteBranches?: boolean }) => {
          const ctx = await createContext();
          await sessionEnd(ctx, name, options);
        }
      )
    );

  // Delete session
  session
    .command('delete <name>')
    .description('Delete a session permanently')
    .option('-f, --force', 'Also delete session branches from git')
    .action(
      withErrorHandling(async (name: string, options: { force?: boolean }) => {
        const ctx = await createContext();
        await sessionDelete(ctx, name, options);
      })
    );

  // Checkout session branches
  session
    .command('checkout [name]')
    .description('Checkout session branches in all modules')
    .option('-f, --force', 'Force checkout even with uncommitted changes')
    .action(
      withErrorHandling(async (name: string | undefined, options: { force?: boolean }) => {
        const ctx = await createContext();
        await sessionCheckout(ctx, name, options);
      })
    );

  // List sessions
  session
    .command('list')
    .description('List all sessions')
    .option('-a, --all', 'Include ended sessions')
    .action(
      withErrorHandling(async (options: { all?: boolean }) => {
        const ctx = await createContext();
        await sessionList(ctx, options);
      })
    );

  // Show session status
  session
    .command('status [name]')
    .description('Show session status')
    .action(
      withErrorHandling(async (name: string | undefined) => {
        const ctx = await createContext();
        await sessionStatus(ctx, name);
      })
    );

  // Add module to session
  session
    .command('add <module>')
    .description('Add a module to active session')
    .action(
      withErrorHandling(async (module: string) => {
        const ctx = await createContext();
        await sessionAddModule(ctx, module);
      })
    );

  // Remove module from session
  session
    .command('remove <module>')
    .description('Remove a module from active session')
    .action(
      withErrorHandling(async (module: string) => {
        const ctx = await createContext();
        await sessionRemoveModule(ctx, module);
      })
    );

  // List templates
  session
    .command('templates')
    .description('List available session templates')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await listTemplates(ctx);
      })
    );

  // Switch active session
  session
    .command('switch <name>')
    .description('Switch to a different session')
    .action(
      withErrorHandling(async (name: string) => {
        const ctx = await createContext();
        await sessionSwitch(ctx, name);
      })
    );

  // Pause session
  session
    .command('pause')
    .description('Pause session: stash changes, checkout default branches')
    .option('-u, --include-untracked', 'Include untracked files in stash')
    .action(
      withErrorHandling(async (options: { includeUntracked?: boolean }) => {
        const ctx = await createContext();
        await sessionPause(ctx, options);
      })
    );

  // Resume session
  session
    .command('resume [name]')
    .description('Resume paused session: checkout session branches, pop stash')
    .action(
      withErrorHandling(async (name: string | undefined) => {
        const ctx = await createContext();
        await sessionResume(ctx, name);
      })
    );
}

// ============================================================================
// Session Start
// ============================================================================

async function sessionStart(
  ctx: IExecutionContext,
  name: string,
  options: {
    modules?: string[];
    template?: string;
    base?: string;
    description?: string;
    checkout?: boolean;
  }
): Promise<void> {
  const sessions = ctx.state.sessions ?? {};

  // Check if session exists
  if (sessions[name]?.status === 'active') {
    throw new SessionError(`Session '${name}' already exists and is active`);
  }

  ctx.output.header(`Start Session: ${name}`);

  // Apply template if specified
  let template: SessionTemplate | undefined;
  if (options.template) {
    template = SESSION_TEMPLATES[options.template];
    if (!template) {
      throw new SessionError(
        `Unknown template: ${options.template}. Use 'jic session templates' to list available templates.`
      );
    }
    ctx.output.keyValue('Template', options.template);
  }

  // Determine modules
  let modules: ResolvedModule[];
  if (options.modules) {
    modules = ctx.resolveModules(options.modules);
  } else if (template) {
    modules = ctx.resolveModules(template.moduleGroups);
  } else {
    // Default to all modules
    modules = Object.values(ctx.config.resolvedModules);
  }

  // Determine base branch - if explicitly provided or from template, use that for all modules
  // Otherwise, use each module's local default branch
  const explicitBaseBranch = options.base ?? template?.baseBranch;
  const branchPrefix = template?.branchPrefix ?? 'feature/';
  const sessionBranch = `${branchPrefix}${name}`;

  if (explicitBaseBranch) {
    ctx.output.keyValue('Base Branch', explicitBaseBranch);
  } else {
    ctx.output.keyValue('Base Branch', 'each module\'s local default');
  }
  ctx.output.keyValue('Session Branch', sessionBranch);
  ctx.output.keyValue('Modules', modules.map((m) => m.name).join(', '));
  ctx.output.newline();

  // Create session record
  const sessionData: Session = {
    name,
    description: options.description ?? template?.description ?? '',
    createdAt: new Date().toISOString(),
    status: 'active',
    baseBranch: explicitBaseBranch ?? 'local-default', // marker for per-module default
    sessionBranch,
    modules: {},
    mergedBranches: [],
  };

  // Create branches in each module
  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: creating branch`);
    spinner.start();

    // Determine base branch for this module
    const moduleBaseBranch = explicitBaseBranch ??
      module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would create branch ${sessionBranch} from ${moduleBaseBranch}`);
        sessionData.modules[module.name] = { branch: sessionBranch, baseBranch: moduleBaseBranch };
        continue;
      }

      // Check for uncommitted changes
      const status = await getGitStatus(module.absolutePath);
      if (!status.clean) {
        spinner.warn(`${module.name}: has uncommitted changes, skipping branch creation`);
        continue;
      }

      // Check if branch already exists
      const branchExists = await checkBranchExists(module, sessionBranch);
      if (branchExists) {
        // Just checkout existing branch
        const checkoutResult = await exec(`git checkout ${sessionBranch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        if (!checkoutResult.success) {
          spinner.fail(`${module.name}: failed to checkout ${sessionBranch}`);
          if (checkoutResult.stderr) {
            ctx.output.error(`  ${checkoutResult.stderr}`);
          }
          continue;
        }
        spinner.succeed(`${module.name}: checked out existing ${sessionBranch}`);
      } else {
        // Create new branch from base
        const createResult = await exec(`git checkout -b ${sessionBranch} ${moduleBaseBranch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        if (!createResult.success) {
          spinner.fail(`${module.name}: failed to create ${sessionBranch} from ${moduleBaseBranch}`);
          if (createResult.stderr) {
            ctx.output.error(`  ${createResult.stderr}`);
          }
          continue;
        }
        spinner.succeed(`${module.name}: created ${sessionBranch} from ${moduleBaseBranch}`);
      }

      sessionData.modules[module.name] = {
        branch: sessionBranch,
        baseBranch: moduleBaseBranch,
        commit: await getGitCommit(module.absolutePath) ?? undefined,
      };
    } catch (error) {
      spinner.fail(`${module.name}: failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }

  // Save session
  if (!ctx.dryRun) {
    if (!ctx.state.sessions) {
      ctx.state.sessions = {};
    }
    ctx.state.sessions[name] = sessionData;
    ctx.state.activeSession = name;
    await ctx.saveState();
  }

  ctx.output.newline();
  ctx.output.success(`Session '${name}' started`);
  ctx.output.info('Commands will now auto-scope to session modules');
}

// ============================================================================
// Session End
// ============================================================================

async function sessionEnd(
  ctx: IExecutionContext,
  name: string | undefined,
  options: { merge?: boolean; deleteBranches?: boolean }
): Promise<void> {
  const sessionName = name ?? ctx.state.activeSession;
  if (!sessionName) {
    throw new SessionError('No active session. Specify session name or start a session first.');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  ctx.output.header(`End Session: ${sessionName}`);

  // Merge if requested
  if (options.merge) {
    await mergeSessionBranches(ctx, session, options.deleteBranches);
  }

  // Checkout to default local branches in all session modules
  ctx.output.newline();
  ctx.output.subheader('Checking out default branches');

  for (const [moduleName] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    const defaultBranch = module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    const spinner = ctx.output.spinner(`${moduleName}: checkout ${defaultBranch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would checkout ${defaultBranch}`);
        continue;
      }

      // Check for uncommitted changes
      const status = await getGitStatus(module.absolutePath);
      if (!status.clean) {
        spinner.warn(`${moduleName}: has uncommitted changes, skipping checkout`);
        continue;
      }

      const checkoutResult = await exec(`git checkout ${defaultBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!checkoutResult.success) {
        spinner.fail(`${moduleName}: failed to checkout ${defaultBranch}`);
        if (checkoutResult.stderr) {
          ctx.output.error(`  ${checkoutResult.stderr}`);
        }
        continue;
      }
      spinner.succeed(`${moduleName}: on ${defaultBranch}`);
    } catch (error) {
      spinner.fail(`${moduleName}: checkout failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }

  // Update session status
  if (!ctx.dryRun) {
    session.status = 'ended';
    session.endedAt = new Date().toISOString();

    // Clear active session if this was it
    if (ctx.state.activeSession === sessionName) {
      ctx.state.activeSession = undefined;
    }

    await ctx.saveState();
  }

  ctx.output.newline();
  ctx.output.success(`Session '${sessionName}' ended`);
}

// ============================================================================
// Session Delete
// ============================================================================

async function sessionDelete(
  ctx: IExecutionContext,
  name: string,
  options: { force?: boolean }
): Promise<void> {
  const session = ctx.state.sessions?.[name];
  if (!session) {
    throw new SessionError(`Session '${name}' not found`);
  }

  ctx.output.header(`Delete Session: ${name}`);

  // Warn if session is active
  if (session.status === 'active') {
    ctx.output.warning('This session is currently active');
  }

  // Delete branches if --force
  if (options.force) {
    ctx.output.subheader('Deleting branches');

    for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
      const module = ctx.getModule(moduleName);
      if (!module) continue;

      const spinner = ctx.output.spinner(`${moduleName}: deleting ${moduleSession.branch}`);
      spinner.start();

      try {
        if (ctx.dryRun) {
          spinner.info(`[dry-run] Would delete branch ${moduleSession.branch}`);
          continue;
        }

        // Check if we're currently on this branch
        const currentBranch = await getGitBranch(module.absolutePath);
        if (currentBranch === moduleSession.branch) {
          // Checkout default branch first
          const defaultBranch = moduleSession.baseBranch ??
            module.branches?.local ??
            ctx.config.defaults.branches?.local ??
            'main';

          const checkoutResult = await exec(`git checkout ${defaultBranch}`, {
            cwd: module.absolutePath,
            silent: true,
          });
          if (!checkoutResult.success) {
            spinner.fail(`${moduleName}: cannot checkout ${defaultBranch} before deleting`);
            if (checkoutResult.stderr) {
              ctx.output.error(`  ${checkoutResult.stderr}`);
            }
            continue;
          }
        }

        // Delete the branch
        const deleteResult = await exec(`git branch -D ${moduleSession.branch}`, {
          cwd: module.absolutePath,
          silent: true,
        });

        if (deleteResult.success) {
          spinner.succeed(`${moduleName}: deleted ${moduleSession.branch}`);
        } else {
          // Branch might not exist locally
          if (deleteResult.stderr?.includes('not found')) {
            spinner.info(`${moduleName}: branch not found (already deleted?)`);
          } else {
            spinner.fail(`${moduleName}: failed to delete`);
            if (deleteResult.stderr) {
              ctx.output.error(`  ${deleteResult.stderr}`);
            }
          }
        }
      } catch (error) {
        spinner.fail(`${moduleName}: error deleting branch`);
        if (ctx.verbose && error instanceof Error) {
          ctx.output.error(`  ${error.message}`);
        }
      }
    }

    ctx.output.newline();
  }

  // Remove session from state
  if (!ctx.dryRun) {
    delete ctx.state.sessions?.[name];

    // Clear active session if this was it
    if (ctx.state.activeSession === name) {
      ctx.state.activeSession = undefined;
    }

    await ctx.saveState();
  }

  ctx.output.success(`Session '${name}' deleted`);
  if (!options.force) {
    ctx.output.info('Branches were not deleted. Use --force to also delete git branches.');
  }
}

async function mergeSessionBranches(
  ctx: IExecutionContext,
  session: Session,
  deleteBranches?: boolean
): Promise<void> {
  ctx.output.subheader('Merging branches');

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    // Use per-module base branch if stored, otherwise fall back to session base or module default
    const targetBranch = moduleSession.baseBranch ??
      (session.baseBranch !== 'local-default' ? session.baseBranch : null) ??
      module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    const spinner = ctx.output.spinner(`${moduleName}: merging to ${targetBranch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would merge ${moduleSession.branch} to ${targetBranch}`);
        continue;
      }

      // Checkout base branch
      const checkoutResult = await exec(`git checkout ${targetBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!checkoutResult.success) {
        spinner.fail(`${moduleName}: failed to checkout ${targetBranch}`);
        if (checkoutResult.stderr) {
          ctx.output.error(`  ${checkoutResult.stderr}`);
        }
        continue;
      }

      // Merge session branch
      const mergeResult = await exec(`git merge ${moduleSession.branch} --no-edit`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!mergeResult.success) {
        spinner.fail(`${moduleName}: merge failed`);
        if (mergeResult.stderr) {
          ctx.output.error(`  ${mergeResult.stderr}`);
        }
        continue;
      }

      spinner.succeed(`${moduleName}: merged to ${targetBranch}`);

      // Delete branch if requested
      if (deleteBranches) {
        const deleteResult = await exec(`git branch -d ${moduleSession.branch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        if (deleteResult.success) {
          ctx.output.info(`  Deleted branch ${moduleSession.branch}`);
        }
      }
    } catch (error) {
      spinner.fail(`${moduleName}: merge failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }
}

// ============================================================================
// Session Checkout
// ============================================================================

async function sessionCheckout(
  ctx: IExecutionContext,
  name: string | undefined,
  options: { force?: boolean }
): Promise<void> {
  const sessionName = name ?? ctx.state.activeSession;
  if (!sessionName) {
    throw new SessionError('No active session. Specify session name or start a session first.');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  ctx.output.header(`Checkout Session: ${sessionName}`);

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    const spinner = ctx.output.spinner(`${moduleName}: checking out ${moduleSession.branch}`);
    spinner.start();

    try {
      // Check for uncommitted changes
      if (!options.force) {
        const status = await getGitStatus(module.absolutePath);
        if (!status.clean) {
          spinner.warn(`${moduleName}: has uncommitted changes, skipping`);
          continue;
        }
      }

      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would checkout ${moduleSession.branch}`);
        continue;
      }

      const checkoutResult = await exec(`git checkout ${moduleSession.branch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!checkoutResult.success) {
        spinner.fail(`${moduleName}: failed to checkout ${moduleSession.branch}`);
        if (checkoutResult.stderr) {
          ctx.output.error(`  ${checkoutResult.stderr}`);
        }
        continue;
      }
      spinner.succeed(`${moduleName}: on ${moduleSession.branch}`);
    } catch (error) {
      spinner.fail(`${moduleName}: checkout failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }
}

// ============================================================================
// Session List
// ============================================================================

async function sessionList(ctx: IExecutionContext, options: { all?: boolean }): Promise<void> {
  ctx.output.header('Sessions');

  const sessions = ctx.state.sessions ?? {};
  const sessionList = Object.values(sessions);

  if (sessionList.length === 0) {
    ctx.output.info('No sessions found');
    return;
  }

  const filtered = options.all
    ? sessionList
    : sessionList.filter((s) => s.status === 'active');

  if (filtered.length === 0) {
    ctx.output.info('No active sessions. Use --all to see ended sessions.');
    return;
  }

  const rows: string[][] = [];

  for (const session of filtered) {
    const isActive = ctx.state.activeSession === session.name;
    const moduleCount = Object.keys(session.modules).length;

    // Check if session branch was merged
    const mergeInfo = await checkSessionMergeStatus(ctx, session);

    rows.push([
      isActive ? colors.success(`* ${session.name}`) : `  ${session.name}`,
      session.status === 'active' ? colors.success('active') : colors.muted('ended'),
      String(moduleCount),
      session.sessionBranch,
      new Date(session.createdAt).toLocaleDateString(),
      mergeInfo.merged
        ? colors.success(`Yes (${mergeInfo.mergedAt ?? 'unknown'})`)
        : colors.muted('No'),
    ]);
  }

  ctx.output.table(rows, {
    head: ['Name', 'Status', 'Modules', 'Branch', 'Created', 'Merged'],
  });
}

/**
 * Check if a session's branches have been merged into their base branches.
 * A session is considered merged only if:
 * 1. The session branch has commits beyond its starting point (actual work was done)
 * 2. Those commits are now ancestors of the local dev branch
 */
async function checkSessionMergeStatus(
  ctx: IExecutionContext,
  session: Session
): Promise<{ merged: boolean; mergedAt?: string }> {
  const moduleEntries = Object.entries(session.modules);
  if (moduleEntries.length === 0) {
    return { merged: false };
  }

  let mergedCount = 0;
  let checkedCount = 0;
  let latestMergeDate: Date | null = null;

  for (const [moduleName, moduleSession] of moduleEntries) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    // Determine the local dev branch for this module
    const localBranch = module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    try {
      // First check if the session branch still exists
      const branchExists = await exec(
        `git show-ref --verify --quiet refs/heads/${moduleSession.branch}`,
        { cwd: module.absolutePath, silent: true }
      );

      if (!branchExists.success) {
        // Branch doesn't exist - could have been deleted after merge
        // Check if we had a starting commit and if it's in the local branch
        if (moduleSession.commit) {
          const commitInLocal = await exec(
            `git merge-base --is-ancestor ${moduleSession.commit} ${localBranch}`,
            { cwd: module.absolutePath, silent: true }
          );
          if (commitInLocal.success) {
            // Starting commit is in local, but we can't verify if work was done
            // Skip this module for merge detection
          }
        }
        continue;
      }

      checkedCount++;

      // Get current HEAD of the session branch
      const sessionHeadResult = await exec(
        `git rev-parse ${moduleSession.branch}`,
        { cwd: module.absolutePath, silent: true }
      );
      const sessionHead = sessionHeadResult.stdout?.trim();
      if (!sessionHead) continue;

      // Check if work was done on the session branch
      // Compare current HEAD with starting commit
      const startingCommit = moduleSession.commit;
      if (startingCommit && sessionHead === startingCommit) {
        // No commits were made on this session branch - nothing to merge
        continue;
      }

      // Work was done - check if it's been merged into the local dev branch
      const mergeResult = await exec(
        `git merge-base --is-ancestor ${sessionHead} ${localBranch}`,
        { cwd: module.absolutePath, silent: true }
      );

      if (mergeResult.success) {
        mergedCount++;

        // Try to find when it was merged
        const mergeLogResult = await exec(
          `git log --format=%aI --ancestry-path ${sessionHead}..${localBranch} -1`,
          { cwd: module.absolutePath, silent: true }
        );

        if (mergeLogResult.stdout?.trim()) {
          const mergeDate = new Date(mergeLogResult.stdout.trim());
          if (!latestMergeDate || mergeDate > latestMergeDate) {
            latestMergeDate = mergeDate;
          }
        }
      }
    } catch {
      // Branch might not exist or other git error - skip
    }
  }

  // Consider session merged only if at least one module with work was merged
  const merged = mergedCount > 0 && mergedCount === checkedCount;
  const mergedAt = latestMergeDate ? latestMergeDate.toLocaleDateString() : undefined;

  return { merged, mergedAt };
}

// ============================================================================
// Session Status
// ============================================================================

async function sessionStatus(ctx: IExecutionContext, name: string | undefined): Promise<void> {
  const sessionName = name ?? ctx.state.activeSession;
  if (!sessionName) {
    ctx.output.info('No active session');
    ctx.output.info('Start one with: jic session start <name>');
    return;
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  ctx.output.header(`Session: ${sessionName}`);
  ctx.output.keyValue('Status', session.status);
  ctx.output.keyValue('Branch', session.sessionBranch);
  ctx.output.keyValue('Base', session.baseBranch);
  ctx.output.keyValue('Created', new Date(session.createdAt).toLocaleString());
  if (session.description) {
    ctx.output.keyValue('Description', session.description);
  }
  ctx.output.newline();

  ctx.output.subheader('Modules');

  const rows: string[][] = [];

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) {
      rows.push([moduleName, colors.error('not found'), '-', '-']);
      continue;
    }

    const currentBranch = await getGitBranch(module.absolutePath);
    const status = await getGitStatus(module.absolutePath);
    const onSessionBranch = currentBranch === moduleSession.branch;

    rows.push([
      ctx.output.module(moduleName),
      onSessionBranch ? colors.success(currentBranch ?? '-') : colors.warning(currentBranch ?? '-'),
      status.clean ? colors.success('clean') : colors.warning('modified'),
      moduleSession.commit?.substring(0, 7) ?? '-',
    ]);
  }

  ctx.output.table(rows, {
    head: ['Module', 'Branch', 'Status', 'Start Commit'],
  });
}

// ============================================================================
// Session Add/Remove Module
// ============================================================================

async function sessionAddModule(ctx: IExecutionContext, moduleRef: string): Promise<void> {
  const sessionName = ctx.state.activeSession;
  if (!sessionName) {
    throw new SessionError('No active session');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  const module = ctx.getModule(moduleRef);
  if (!module) {
    throw new SessionError(`Module '${moduleRef}' not found`);
  }

  if (session.modules[module.name]) {
    ctx.output.info(`${module.name} is already in session`);
    return;
  }

  ctx.output.header(`Add Module: ${module.name}`);

  // Determine base branch for this module
  // Use session's explicit base if set, otherwise use module's local default
  const moduleBaseBranch = session.baseBranch !== 'local-default'
    ? session.baseBranch
    : module.branches?.local ?? ctx.config.defaults.branches?.local ?? 'main';

  const spinner = ctx.output.spinner(`Creating branch ${session.sessionBranch} from ${moduleBaseBranch}`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would create branch and add to session`);
      return;
    }

    // Create branch
    const branchExists = await checkBranchExists(module, session.sessionBranch);
    let execResult;
    if (!branchExists) {
      execResult = await exec(`git checkout -b ${session.sessionBranch} ${moduleBaseBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
    } else {
      execResult = await exec(`git checkout ${session.sessionBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
    }

    if (!execResult.success) {
      spinner.fail(`Failed to checkout/create branch`);
      if (execResult.stderr) {
        ctx.output.error(`  ${execResult.stderr}`);
      }
      throw new SessionError(`Failed to create branch ${session.sessionBranch}`);
    }

    // Add to session
    session.modules[module.name] = {
      branch: session.sessionBranch,
      baseBranch: moduleBaseBranch,
      commit: await getGitCommit(module.absolutePath) ?? undefined,
    };

    await ctx.saveState();
    spinner.succeed(`Added ${module.name} to session`);
  } catch (error) {
    spinner.fail('Failed to add module');
    throw error;
  }
}

async function sessionRemoveModule(ctx: IExecutionContext, moduleRef: string): Promise<void> {
  const sessionName = ctx.state.activeSession;
  if (!sessionName) {
    throw new SessionError('No active session');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  const module = ctx.getModule(moduleRef);
  if (!module) {
    throw new SessionError(`Module '${moduleRef}' not found`);
  }

  if (!session.modules[module.name]) {
    ctx.output.info(`${module.name} is not in session`);
    return;
  }

  if (ctx.dryRun) {
    ctx.output.info(`[dry-run] Would remove ${module.name} from session`);
    return;
  }

  delete session.modules[module.name];
  await ctx.saveState();

  ctx.output.success(`Removed ${module.name} from session`);
}

// ============================================================================
// Session Switch
// ============================================================================

async function sessionSwitch(ctx: IExecutionContext, name: string): Promise<void> {
  const session = ctx.state.sessions?.[name];
  if (!session) {
    throw new SessionError(`Session '${name}' not found`);
  }

  if (session.status !== 'active') {
    throw new SessionError(`Session '${name}' is not active`);
  }

  if (ctx.dryRun) {
    ctx.output.info(`[dry-run] Would switch to session '${name}'`);
    return;
  }

  ctx.state.activeSession = name;
  await ctx.saveState();

  ctx.output.success(`Switched to session '${name}'`);

  // Optionally checkout branches
  ctx.output.info('Use "jic session checkout" to checkout session branches');
}

// ============================================================================
// Templates
// ============================================================================

async function listTemplates(ctx: IExecutionContext): Promise<void> {
  ctx.output.header('Session Templates');

  const rows: string[][] = [];

  for (const [name, template] of Object.entries(SESSION_TEMPLATES)) {
    rows.push([
      colors.primary(name),
      template.description,
      template.moduleGroups.join(', '),
      template.baseBranch,
    ]);
  }

  ctx.output.table(rows, {
    head: ['Template', 'Description', 'Modules', 'Base Branch'],
  });

  ctx.output.newline();
  ctx.output.info('Use templates with: jic session start <name> --template <template>');
}

// ============================================================================
// Session Pause
// ============================================================================

async function sessionPause(
  ctx: IExecutionContext,
  options: { includeUntracked?: boolean }
): Promise<void> {
  const sessionName = ctx.state.activeSession;
  if (!sessionName) {
    throw new SessionError('No active session to pause');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  if (session.status !== 'active') {
    throw new SessionError(`Session '${sessionName}' is not active (status: ${session.status})`);
  }

  ctx.output.header(`Pause Session: ${sessionName}`);

  // Step 1: Stash changes in all session modules with uncommitted changes
  ctx.output.subheader('Stashing changes');

  const stashMessage = `jic-session-pause:${sessionName}:${new Date().toISOString()}`;
  let stashedCount = 0;

  for (const [moduleName] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    const status = await getGitStatus(module.absolutePath);
    if (status.clean) continue;

    const spinner = ctx.output.spinner(`${moduleName}: stashing`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would stash changes`);
        stashedCount++;
        continue;
      }

      let cmd = `git stash push -m "${stashMessage}"`;
      if (options.includeUntracked) cmd += ' -u';

      const stashResult = await exec(cmd, { cwd: module.absolutePath, silent: true });
      if (!stashResult.success) {
        spinner.fail(`${moduleName}: stash failed`);
        if (stashResult.stderr) {
          ctx.output.error(`  ${stashResult.stderr}`);
        }
        continue;
      }
      spinner.succeed(`${moduleName}: stashed`);
      stashedCount++;
    } catch (error) {
      spinner.fail(`${moduleName}: stash failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }

  if (stashedCount === 0) {
    ctx.output.info('No changes to stash');
  }

  // Step 2: Checkout default local branches
  ctx.output.newline();
  ctx.output.subheader('Checking out default branches');

  for (const [moduleName] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    const defaultBranch = module.branches?.local ??
      ctx.config.defaults.branches?.local ??
      'main';

    const spinner = ctx.output.spinner(`${moduleName}: checkout ${defaultBranch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would checkout ${defaultBranch}`);
        continue;
      }

      const checkoutResult = await exec(`git checkout ${defaultBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!checkoutResult.success) {
        spinner.fail(`${moduleName}: failed to checkout ${defaultBranch}`);
        if (checkoutResult.stderr) {
          ctx.output.error(`  ${checkoutResult.stderr}`);
        }
        continue;
      }
      spinner.succeed(`${moduleName}: on ${defaultBranch}`);
    } catch (error) {
      spinner.fail(`${moduleName}: checkout failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }

  // Step 3: Update session status and clear active session
  if (!ctx.dryRun) {
    session.status = 'paused';
    ctx.state.activeSession = undefined;
    await ctx.saveState();
  }

  ctx.output.newline();
  ctx.output.success(`Session '${sessionName}' paused`);
  ctx.output.info('Resume with: jic session resume');
}

// ============================================================================
// Session Resume
// ============================================================================

async function sessionResume(
  ctx: IExecutionContext,
  name: string | undefined
): Promise<void> {
  // Find session to resume
  let sessionName = name;

  if (!sessionName) {
    // Look for paused session
    const pausedSession = Object.entries(ctx.state.sessions ?? {})
      .find(([, s]) => s.status === 'paused');

    if (pausedSession) {
      sessionName = pausedSession[0];
    } else if (ctx.state.activeSession) {
      sessionName = ctx.state.activeSession;
    }
  }

  if (!sessionName) {
    throw new SessionError('No paused session to resume. Specify session name.');
  }

  const session = ctx.state.sessions?.[sessionName];
  if (!session) {
    throw new SessionError(`Session '${sessionName}' not found`);
  }

  if (session.status !== 'paused' && session.status !== 'active') {
    throw new SessionError(`Session '${sessionName}' cannot be resumed (status: ${session.status})`);
  }

  ctx.output.header(`Resume Session: ${sessionName}`);

  // Step 1: Checkout session branches
  ctx.output.subheader('Checking out session branches');

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    const spinner = ctx.output.spinner(`${moduleName}: checkout ${moduleSession.branch}`);
    spinner.start();

    try {
      // Check for uncommitted changes
      const status = await getGitStatus(module.absolutePath);
      if (!status.clean) {
        spinner.warn(`${moduleName}: has uncommitted changes, skipping`);
        continue;
      }

      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would checkout ${moduleSession.branch}`);
        continue;
      }

      const checkoutResult = await exec(`git checkout ${moduleSession.branch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
      if (!checkoutResult.success) {
        spinner.fail(`${moduleName}: failed to checkout ${moduleSession.branch}`);
        if (checkoutResult.stderr) {
          ctx.output.error(`  ${checkoutResult.stderr}`);
        }
        continue;
      }
      spinner.succeed(`${moduleName}: on ${moduleSession.branch}`);
    } catch (error) {
      spinner.fail(`${moduleName}: checkout failed`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }

  // Step 2: Pop stashes that match this session
  ctx.output.newline();
  ctx.output.subheader('Restoring stashed changes');

  const stashPrefix = `jic-session-pause:${sessionName}:`;
  let restoredCount = 0;

  for (const [moduleName] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) continue;

    try {
      // Check if there's a matching stash
      const listResult = await exec('git stash list', {
        cwd: module.absolutePath,
        silent: true,
      });

      const stashes = listResult.stdout?.trim().split('\n').filter(Boolean) ?? [];
      const matchingStash = stashes.find((s) => s.includes(stashPrefix));

      if (!matchingStash) continue;

      const spinner = ctx.output.spinner(`${moduleName}: restoring stash`);
      spinner.start();

      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would pop stash`);
        restoredCount++;
        continue;
      }

      // Get stash index
      const stashMatch = matchingStash.match(/^(stash@\{\d+\})/);
      if (stashMatch) {
        await exec(`git stash pop ${stashMatch[1]}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        spinner.succeed(`${moduleName}: restored`);
        restoredCount++;
      }
    } catch (error) {
      ctx.output.warning(`${moduleName}: failed to restore stash (conflict?)`);
    }
  }

  if (restoredCount === 0) {
    ctx.output.info('No stashes to restore');
  }

  // Step 3: Update session status
  if (!ctx.dryRun) {
    session.status = 'active';
    ctx.state.activeSession = sessionName;
    await ctx.saveState();
  }

  ctx.output.newline();
  ctx.output.success(`Session '${sessionName}' resumed`);
}

// ============================================================================
// Helpers
// ============================================================================

async function checkBranchExists(module: ResolvedModule, branch: string): Promise<boolean> {
  const result = await exec(`git show-ref --verify --quiet refs/heads/${branch}`, {
    cwd: module.absolutePath,
    silent: true,
  });
  return result.success;
}
