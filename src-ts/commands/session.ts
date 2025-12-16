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

  // Determine base branch
  const baseBranch = options.base ?? template?.baseBranch ?? 'feature/samuele';
  const branchPrefix = template?.branchPrefix ?? 'feature/';
  const sessionBranch = `${branchPrefix}${name}`;

  ctx.output.keyValue('Base Branch', baseBranch);
  ctx.output.keyValue('Session Branch', sessionBranch);
  ctx.output.keyValue('Modules', modules.map((m) => m.name).join(', '));
  ctx.output.newline();

  // Create session record
  const sessionData: Session = {
    name,
    description: options.description ?? template?.description ?? '',
    createdAt: new Date().toISOString(),
    status: 'active',
    baseBranch,
    sessionBranch,
    modules: {},
    mergedBranches: [],
  };

  // Create branches in each module
  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: creating branch`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would create branch ${sessionBranch}`);
        sessionData.modules[module.name] = { branch: sessionBranch };
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
        await exec(`git checkout ${sessionBranch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        spinner.succeed(`${module.name}: checked out existing ${sessionBranch}`);
      } else {
        // Create new branch from base
        await exec(`git checkout -b ${sessionBranch} ${baseBranch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        spinner.succeed(`${module.name}: created ${sessionBranch}`);
      }

      sessionData.modules[module.name] = {
        branch: sessionBranch,
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

  ctx.output.success(`Session '${sessionName}' ended`);
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

    const spinner = ctx.output.spinner(`${moduleName}: merging to ${session.baseBranch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would merge ${moduleSession.branch} to ${session.baseBranch}`);
        continue;
      }

      // Checkout base branch
      await exec(`git checkout ${session.baseBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });

      // Merge session branch
      await exec(`git merge ${moduleSession.branch} --no-edit`, {
        cwd: module.absolutePath,
        silent: true,
      });

      spinner.succeed(`${moduleName}: merged`);

      // Delete branch if requested
      if (deleteBranches) {
        await exec(`git branch -d ${moduleSession.branch}`, {
          cwd: module.absolutePath,
          silent: true,
        });
        ctx.output.info(`  Deleted branch ${moduleSession.branch}`);
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

      await exec(`git checkout ${moduleSession.branch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
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

    rows.push([
      isActive ? colors.success(`* ${session.name}`) : `  ${session.name}`,
      session.status === 'active' ? colors.success('active') : colors.muted('ended'),
      String(moduleCount),
      session.sessionBranch,
      new Date(session.createdAt).toLocaleDateString(),
    ]);
  }

  ctx.output.table(rows, {
    head: ['Name', 'Status', 'Modules', 'Branch', 'Created'],
  });
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

  const spinner = ctx.output.spinner(`Creating branch ${session.sessionBranch}`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would create branch and add to session`);
      return;
    }

    // Create branch
    const branchExists = await checkBranchExists(module, session.sessionBranch);
    if (!branchExists) {
      await exec(`git checkout -b ${session.sessionBranch} ${session.baseBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
    } else {
      await exec(`git checkout ${session.sessionBranch}`, {
        cwd: module.absolutePath,
        silent: true,
      });
    }

    // Add to session
    session.modules[module.name] = {
      branch: session.sessionBranch,
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
// Helpers
// ============================================================================

async function checkBranchExists(module: ResolvedModule, branch: string): Promise<boolean> {
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
