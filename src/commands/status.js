/**
 * Status commands for project overview
 *
 * Commands:
 *   jic status - Overall project status
 *   jic status modules - Module status
 *   jic status builds - Build status
 *   jic status deploys - Deployment status
 */

import { withErrorHandling } from '../utils/error.js';
import { getGitBranch, getGitStatus, getGitCommit } from '../utils/shell.js';
import { output, formatModuleStatus } from '../utils/output.js';

/**
 * Register status commands
 */
export function registerStatusCommands(program, ctx) {
  const status = program
    .command('status')
    .description('Project status overview')
    .action(withErrorHandling(async () => {
      await statusOverview(ctx);
    }));

  status
    .command('modules')
    .description('Show module status')
    .action(withErrorHandling(async () => {
      await statusModules(ctx);
    }));

  status
    .command('builds')
    .description('Show build status')
    .action(withErrorHandling(async () => {
      await statusBuilds(ctx);
    }));

  status
    .command('deploys')
    .description('Show deployment status')
    .option('-e, --env <env>', 'Environment filter')
    .action(withErrorHandling(async (options) => {
      await statusDeploys(ctx, options);
    }));

  status
    .command('sessions')
    .description('Show session status')
    .action(withErrorHandling(async () => {
      await statusSessions(ctx);
    }));
}

/**
 * Overall project status
 */
async function statusOverview(ctx) {
  if (!ctx.isInitialized) {
    output.warning('Project not initialized. Run `jic config init` to get started.');
    return;
  }

  output.header(`Project: ${ctx.config.project?.name || 'Unknown'}`);

  // Project info
  if (ctx.config.project?.description) {
    output.info(ctx.config.project.description);
  }

  output.newline();

  // Quick stats
  const modules = Object.values(ctx.config.modules || {});
  const sessions = Object.values(ctx.config.state?.sessions || {});
  const activeSessions = sessions.filter(s => s.status === 'active');

  output.keyValue('Total Modules', modules.length);
  output.keyValue('Active Sessions', activeSessions.length);
  output.keyValue('Default Environment', ctx.config.defaults?.environment || 'dev');
  output.keyValue('Default Branch', ctx.config.defaults?.branch || 'N/A');

  // Active session
  if (ctx.config.state?.activeSession) {
    output.newline();
    output.info(`Active Session: ${ctx.config.state.activeSession}`);
  }

  // Module summary by type
  output.newline();
  output.subheader('Modules by Type');

  const typeCount = {};
  for (const module of modules) {
    typeCount[module.type] = (typeCount[module.type] || 0) + 1;
  }

  const rows = Object.entries(typeCount).map(([type, count]) => [type, count]);
  output.table(rows, { head: ['Type', 'Count'] });

  // Last deploy info
  if (ctx.config.state?.lastDeploy) {
    output.newline();
    output.subheader('Last Deployment');

    const lastDeploy = ctx.config.state.lastDeploy;
    output.keyValue('Environment', lastDeploy.environment);
    output.keyValue('Modules', lastDeploy.modules?.join(', ') || 'N/A');
    output.keyValue('Time', new Date(lastDeploy.timestamp).toLocaleString());
    output.keyValue('Status', lastDeploy.success ? 'Success' : 'Failed');
  }
}

/**
 * Module status
 */
async function statusModules(ctx) {
  if (!ctx.isInitialized) {
    output.warning('Project not initialized');
    return;
  }

  output.header('Module Status');

  const modules = Object.values(ctx.config.modules || {});

  if (modules.length === 0) {
    output.info('No modules configured');
    return;
  }

  const rows = [];

  for (const module of modules) {
    const branch = await getGitBranch(module.absolutePath);
    const status = await getGitStatus(module.absolutePath);
    const commit = await getGitCommit(module.absolutePath);

    let statusStr;
    if (status.clean) {
      statusStr = output.colors.success('clean');
    } else {
      const parts = [];
      if (status.modified) parts.push(output.colors.warning(`${status.modified}M`));
      if (status.added) parts.push(output.colors.success(`${status.added}A`));
      if (status.deleted) parts.push(output.colors.error(`${status.deleted}D`));
      statusStr = parts.join(' ');
    }

    rows.push([
      output.module(module.name),
      module.type,
      output.colors.primary(branch || 'N/A'),
      output.colors.muted(commit || 'N/A'),
      statusStr
    ]);
  }

  output.table(rows, {
    head: ['Module', 'Type', 'Branch', 'Commit', 'Status']
  });
}

/**
 * Build status
 */
async function statusBuilds(ctx) {
  if (!ctx.isInitialized) {
    output.warning('Project not initialized');
    return;
  }

  output.header('Build Status');

  const buildCache = ctx.config.state?.buildCache || {};

  if (Object.keys(buildCache).length === 0) {
    output.info('No build history recorded');
    return;
  }

  const rows = Object.entries(buildCache).map(([name, info]) => [
    output.module(name),
    info.success ? output.colors.success('success') : output.colors.error('failed'),
    info.commit || 'N/A',
    info.lastBuild ? new Date(info.lastBuild).toLocaleString() : 'N/A'
  ]);

  output.table(rows, {
    head: ['Module', 'Last Build', 'Commit', 'Time']
  });
}

/**
 * Deployment status
 */
async function statusDeploys(ctx, options) {
  if (!ctx.isInitialized) {
    output.warning('Project not initialized');
    return;
  }

  output.header('Deployment Status');

  const deployVersions = ctx.config.state?.deployVersions || {};
  const environments = options.env ? [options.env] : ['dev', 'prod'];

  for (const env of environments) {
    const envVersions = deployVersions[env] || {};

    output.subheader(env.toUpperCase());

    if (Object.keys(envVersions).length === 0) {
      output.info('No deployments recorded');
      continue;
    }

    const rows = Object.entries(envVersions).map(([name, info]) => [
      output.module(name),
      info.version,
      info.commit || 'N/A',
      info.deployedAt ? new Date(info.deployedAt).toLocaleString() : 'N/A'
    ]);

    output.table(rows, {
      head: ['Service', 'Version', 'Commit', 'Deployed']
    });
  }
}

/**
 * Session status
 */
async function statusSessions(ctx) {
  if (!ctx.isInitialized) {
    output.warning('Project not initialized');
    return;
  }

  output.header('Sessions');

  const sessions = ctx.config.state?.sessions || {};

  if (Object.keys(sessions).length === 0) {
    output.info('No sessions created');
    return;
  }

  const activeSession = ctx.config.state?.activeSession;

  const rows = Object.values(sessions).map(s => {
    const isActive = s.name === activeSession;
    const name = isActive ? `* ${s.name}` : s.name;
    const moduleCount = Object.keys(s.modules).length;

    return [
      isActive ? output.colors.primary(name) : name,
      s.status === 'active' ? output.colors.success(s.status) : output.colors.muted(s.status),
      moduleCount,
      s.sessionBranch,
      new Date(s.createdAt).toLocaleDateString()
    ];
  });

  output.table(rows, {
    head: ['Session', 'Status', 'Modules', 'Branch', 'Created']
  });

  if (activeSession) {
    output.newline();
    output.info(`Use 'jic session status ${activeSession}' for details`);
  }
}

export default { registerStatusCommands };
