/**
 * Session management commands
 *
 * Sessions track work across multiple modules, allowing:
 * - Creating feature branches across related modules
 * - Tracking which modules are part of a work stream
 * - Merging session branches back to release candidate
 *
 * Commands:
 *   jic session start <name> - Start a new work session
 *   jic session end <name> - End session and optionally merge
 *   jic session checkout [name] - Checkout session branches
 *   jic session list - List all sessions
 *   jic session status [name] - Show session status
 *   jic session merge [name] - Merge session to target
 */

import { withErrorHandling, JicError } from '../utils/error.js';
import { exec, execInModule, getGitBranch, getGitStatus } from '../utils/shell.js';
import { output, createSpinner } from '../utils/output.js';
import { saveState } from '../lib/config.js';
import inquirer from 'inquirer';

/**
 * Register session commands
 */
export function registerSessionCommands(program, ctx) {
  const session = program
    .command('session')
    .description('Work session management');

  session
    .command('start <name>')
    .description('Start a new work session')
    .option('-m, --modules <modules...>', 'Modules to include in session')
    .option('-b, --base <branch>', 'Base branch for session')
    .option('-d, --description <desc>', 'Session description')
    .action(withErrorHandling(async (name, options) => {
      await sessionStart(ctx, name, options);
    }));

  session
    .command('end <name>')
    .description('End a work session')
    .option('--merge', 'Merge session branches to base')
    .option('--delete-branches', 'Delete session branches after merge')
    .action(withErrorHandling(async (name, options) => {
      await sessionEnd(ctx, name, options);
    }));

  session
    .command('checkout [name]')
    .description('Checkout session branches in all modules')
    .action(withErrorHandling(async (name) => {
      await sessionCheckout(ctx, name);
    }));

  session
    .command('list')
    .description('List all sessions')
    .option('-a, --all', 'Include ended sessions')
    .action(withErrorHandling(async (options) => {
      await sessionList(ctx, options);
    }));

  session
    .command('status [name]')
    .description('Show session status')
    .action(withErrorHandling(async (name) => {
      await sessionStatus(ctx, name);
    }));

  session
    .command('merge [name]')
    .description('Merge session branches to target')
    .option('-t, --target <branch>', 'Target branch for merge')
    .option('--no-ff', 'Create merge commit even for fast-forward')
    .action(withErrorHandling(async (name, options) => {
      await sessionMerge(ctx, name, options);
    }));

  session
    .command('add-module <name> <module>')
    .description('Add a module to an existing session')
    .action(withErrorHandling(async (name, module, options) => {
      await sessionAddModule(ctx, name, module, options);
    }));

  session
    .command('remove-module <name> <module>')
    .description('Remove a module from a session')
    .action(withErrorHandling(async (name, module, options) => {
      await sessionRemoveModule(ctx, name, module, options);
    }));
}

/**
 * Start a new work session
 */
async function sessionStart(ctx, name, options) {
  const sessions = ctx.config.state.sessions || {};

  if (sessions[name] && sessions[name].status === 'active') {
    throw new JicError(`Session '${name}' already exists and is active`);
  }

  output.header(`Start Session: ${name}`);

  // Determine modules
  let modules;
  if (options.modules) {
    modules = ctx.resolveModules(options.modules);
  } else {
    // Interactive selection
    const allModules = Object.values(ctx.config.modules);
    const { selectedModules } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selectedModules',
      message: 'Select modules for this session:',
      choices: allModules.map(m => ({
        name: `${m.name} (${m.type})`,
        value: m.name,
        checked: false
      }))
    }]);

    if (selectedModules.length === 0) {
      throw new JicError('At least one module must be selected');
    }

    modules = ctx.resolveModules(selectedModules);
  }

  // Determine base branch
  const baseBranch = options.base || ctx.config.defaults?.branch || 'feature/samuele';
  const sessionBranch = `feature/${name}`;

  output.keyValue('Base Branch', baseBranch);
  output.keyValue('Session Branch', sessionBranch);
  output.keyValue('Modules', modules.map(m => m.name).join(', '));
  output.newline();

  // Create session record
  const sessionData = {
    name,
    description: options.description || '',
    createdAt: new Date().toISOString(),
    status: 'active',
    baseBranch,
    sessionBranch,
    modules: {}
  };

  // Create branches in each module
  for (const module of modules) {
    const spinner = createSpinner(`${module.name}: creating ${sessionBranch}`);
    spinner.start();

    try {
      // Determine the module's base branch
      const moduleBaseBranch = module.branches?.local || baseBranch;

      // Check if session branch already exists
      const branchExists = await exec(
        `git show-ref --verify --quiet refs/heads/${sessionBranch}`,
        { cwd: module.absolutePath, silent: true }
      ).then(() => true).catch(() => false);

      if (branchExists) {
        // Checkout existing branch
        await execInModule(module, `git checkout ${sessionBranch}`, { silent: true });
        spinner.warn(`${module.name}: branch exists, checked out`);
      } else {
        // Create new branch from base
        if (ctx.dryRun) {
          spinner.info(`${module.name}: [dry-run] would create from ${moduleBaseBranch}`);
        } else {
          await execInModule(module, `git checkout ${moduleBaseBranch}`, { silent: true });
          await execInModule(module, `git checkout -b ${sessionBranch}`, { silent: true });
          spinner.succeed(`${module.name}: created from ${moduleBaseBranch}`);
        }
      }

      sessionData.modules[module.name] = {
        branch: sessionBranch,
        baseBranch: moduleBaseBranch,
        mergedBranches: []
      };
    } catch (error) {
      spinner.fail(`${module.name}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new JicError(`Failed to create session branch in ${module.name}`);
      }
    }
  }

  // Save session
  if (!ctx.dryRun) {
    ctx.config.state.sessions = ctx.config.state.sessions || {};
    ctx.config.state.sessions[name] = sessionData;
    ctx.config.state.activeSession = name;
    await saveState(ctx.config);
  }

  output.newline();
  output.success(`Session '${name}' started with ${modules.length} modules`);
}

/**
 * End a work session
 */
async function sessionEnd(ctx, name, options) {
  const sessions = ctx.config.state.sessions || {};
  const session = sessions[name];

  if (!session) {
    throw new JicError(`Session '${name}' not found`);
  }

  output.header(`End Session: ${name}`);

  if (options.merge) {
    await sessionMerge(ctx, name, { target: session.baseBranch });
  }

  if (options.deleteBranches) {
    output.subheader('Deleting Session Branches');

    for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
      const module = ctx.getModule(moduleName);
      if (!module) continue;

      const spinner = createSpinner(`${moduleName}: deleting ${session.sessionBranch}`);
      spinner.start();

      try {
        // Switch to base branch first
        await execInModule(module, `git checkout ${moduleSession.baseBranch}`, { silent: true });
        // Delete session branch
        await execInModule(module, `git branch -d ${session.sessionBranch}`, { silent: true });
        spinner.succeed(`${moduleName}: deleted`);
      } catch (error) {
        spinner.fail(`${moduleName}: ${error.message}`);
      }
    }
  }

  // Update session status
  if (!ctx.dryRun) {
    session.status = 'ended';
    session.endedAt = new Date().toISOString();

    if (ctx.config.state.activeSession === name) {
      ctx.config.state.activeSession = null;
    }

    await saveState(ctx.config);
  }

  output.newline();
  output.success(`Session '${name}' ended`);
}

/**
 * Checkout session branches
 */
async function sessionCheckout(ctx, name) {
  const sessions = ctx.config.state.sessions || {};
  const sessionName = name || ctx.config.state.activeSession;

  if (!sessionName) {
    throw new JicError('No session specified and no active session');
  }

  const session = sessions[sessionName];
  if (!session) {
    throw new JicError(`Session '${sessionName}' not found`);
  }

  output.header(`Checkout Session: ${sessionName}`);

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) {
      output.warn(`Module '${moduleName}' not found, skipping`);
      continue;
    }

    const spinner = createSpinner(`${moduleName}: ${moduleSession.branch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`${moduleName}: [dry-run] would checkout ${moduleSession.branch}`);
        continue;
      }

      await execInModule(module, `git checkout ${moduleSession.branch}`, { silent: true });
      spinner.succeed(`${moduleName}: ${moduleSession.branch}`);
    } catch (error) {
      spinner.fail(`${moduleName}: ${error.message}`);
    }
  }

  // Set as active session
  if (!ctx.dryRun) {
    ctx.config.state.activeSession = sessionName;
    await saveState(ctx.config);
  }
}

/**
 * List sessions
 */
async function sessionList(ctx, options) {
  const sessions = ctx.config.state.sessions || {};

  output.header('Sessions');

  const sessionList = Object.values(sessions);

  if (!options.all) {
    sessionList.filter(s => s.status === 'active');
  }

  if (sessionList.length === 0) {
    output.info('No sessions found');
    return;
  }

  const rows = sessionList.map(s => {
    const isActive = ctx.config.state.activeSession === s.name;
    const name = isActive ? `${s.name} *` : s.name;
    const moduleCount = Object.keys(s.modules).length;

    return [
      output.module(name),
      s.status,
      moduleCount,
      s.baseBranch,
      new Date(s.createdAt).toLocaleDateString()
    ];
  });

  output.table(rows, {
    head: ['Session', 'Status', 'Modules', 'Base Branch', 'Created']
  });

  if (ctx.config.state.activeSession) {
    output.newline();
    output.info(`Active session: ${ctx.config.state.activeSession}`);
  }
}

/**
 * Show session status
 */
async function sessionStatus(ctx, name) {
  const sessions = ctx.config.state.sessions || {};
  const sessionName = name || ctx.config.state.activeSession;

  if (!sessionName) {
    throw new JicError('No session specified and no active session');
  }

  const session = sessions[sessionName];
  if (!session) {
    throw new JicError(`Session '${sessionName}' not found`);
  }

  output.header(`Session: ${sessionName}`);

  output.keyValue('Status', session.status);
  output.keyValue('Base Branch', session.baseBranch);
  output.keyValue('Session Branch', session.sessionBranch);
  output.keyValue('Created', new Date(session.createdAt).toLocaleString());
  if (session.description) {
    output.keyValue('Description', session.description);
  }
  output.newline();

  output.subheader('Modules');

  const rows = [];

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);

    if (!module) {
      rows.push([moduleName, 'N/A', 'Module not found', '']);
      continue;
    }

    const currentBranch = await getGitBranch(module.absolutePath);
    const status = await getGitStatus(module.absolutePath);
    const onSessionBranch = currentBranch === moduleSession.branch;

    let statusStr = status.clean ? 'clean' : `${status.modified}M ${status.added}A ${status.deleted}D`;
    if (!onSessionBranch) {
      statusStr = output.colors.warning(`not on session branch (${currentBranch})`);
    }

    const merged = moduleSession.mergedBranches?.length > 0
      ? moduleSession.mergedBranches.join(', ')
      : '-';

    rows.push([
      output.module(moduleName),
      currentBranch,
      statusStr,
      merged
    ]);
  }

  output.table(rows, {
    head: ['Module', 'Current Branch', 'Status', 'Merged Branches']
  });
}

/**
 * Merge session branches to target
 */
async function sessionMerge(ctx, name, options) {
  const sessions = ctx.config.state.sessions || {};
  const sessionName = name || ctx.config.state.activeSession;

  if (!sessionName) {
    throw new JicError('No session specified and no active session');
  }

  const session = sessions[sessionName];
  if (!session) {
    throw new JicError(`Session '${sessionName}' not found`);
  }

  const targetBranch = options.target || session.baseBranch;

  output.header(`Merge Session: ${sessionName} → ${targetBranch}`);

  for (const [moduleName, moduleSession] of Object.entries(session.modules)) {
    const module = ctx.getModule(moduleName);
    if (!module) {
      output.warn(`Module '${moduleName}' not found, skipping`);
      continue;
    }

    const spinner = createSpinner(`${moduleName}: merging into ${targetBranch}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`${moduleName}: [dry-run] would merge ${moduleSession.branch} into ${targetBranch}`);
        continue;
      }

      // Checkout target branch
      await execInModule(module, `git checkout ${targetBranch}`, { silent: true });

      // Merge session branch
      const mergeFlags = options.noFf ? '--no-ff --no-edit' : '--no-edit';
      await execInModule(module, `git merge ${moduleSession.branch} ${mergeFlags}`, { silent: true });

      spinner.succeed(`${moduleName}: merged`);
    } catch (error) {
      spinner.fail(`${moduleName}: ${error.message}`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new JicError(`Merge failed in ${moduleName}`);
      }
    }
  }

  output.newline();
  output.success(`Session '${sessionName}' merged to ${targetBranch}`);
}

/**
 * Add a module to an existing session
 */
async function sessionAddModule(ctx, sessionName, moduleName) {
  const sessions = ctx.config.state.sessions || {};
  const session = sessions[sessionName];

  if (!session) {
    throw new JicError(`Session '${sessionName}' not found`);
  }

  const module = ctx.getModule(moduleName);
  if (!module) {
    throw new JicError(`Module '${moduleName}' not found`);
  }

  if (session.modules[module.name]) {
    throw new JicError(`Module '${module.name}' is already in session '${sessionName}'`);
  }

  output.header(`Add Module: ${module.name} → ${sessionName}`);

  const moduleBaseBranch = module.branches?.local || session.baseBranch;
  const spinner = createSpinner(`Creating ${session.sessionBranch}`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would create ${session.sessionBranch} from ${moduleBaseBranch}`);
      return;
    }

    await execInModule(module, `git checkout ${moduleBaseBranch}`, { silent: true });
    await execInModule(module, `git checkout -b ${session.sessionBranch}`, { silent: true });

    session.modules[module.name] = {
      branch: session.sessionBranch,
      baseBranch: moduleBaseBranch,
      mergedBranches: []
    };

    await saveState(ctx.config);
    spinner.succeed(`Created ${session.sessionBranch} from ${moduleBaseBranch}`);
  } catch (error) {
    spinner.fail(error.message);
    throw error;
  }
}

/**
 * Remove a module from a session
 */
async function sessionRemoveModule(ctx, sessionName, moduleName) {
  const sessions = ctx.config.state.sessions || {};
  const session = sessions[sessionName];

  if (!session) {
    throw new JicError(`Session '${sessionName}' not found`);
  }

  const module = ctx.getModule(moduleName);
  if (!module) {
    throw new JicError(`Module '${moduleName}' not found`);
  }

  if (!session.modules[module.name]) {
    throw new JicError(`Module '${module.name}' is not in session '${sessionName}'`);
  }

  output.header(`Remove Module: ${module.name} from ${sessionName}`);

  if (!ctx.dryRun) {
    delete session.modules[module.name];
    await saveState(ctx.config);
  }

  output.success(`Module '${module.name}' removed from session '${sessionName}'`);
}

export default { registerSessionCommands };
