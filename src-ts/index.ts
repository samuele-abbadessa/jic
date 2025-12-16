/**
 * JIC CLI - JoyInCloud Development Workflow CLI
 *
 * A comprehensive CLI tool for managing multi-module microservices projects.
 * Handles git operations, builds, deployments, and AWS resource management.
 *
 * Version 2.0 - TypeScript rewrite with:
 * - Configuration inheritance
 * - Unified command patterns
 * - Enhanced session management
 * - Robust process management
 */

import { createProgram, getGlobalOptions } from './cli.js';
import { loadConfig, createContext, handleError, Output, colors } from './core/index.js';
import type { IExecutionContext } from './core/context/ExecutionContext.js';
import {
  registerBuildCommand,
  registerGitCommand,
  registerDeployCommand,
  registerServeCommand,
  registerSessionCommand,
  registerAwsCommand,
} from './commands/index.js';
import { registerDashboardCommand } from './dashboard/index.js';

const VERSION = '2.0.0-alpha.1';

/**
 * Create execution context factory
 * This is passed to commands so they can lazily create the context
 */
function createContextFactory(program: ReturnType<typeof createProgram>): () => Promise<IExecutionContext> {
  return async () => {
    const options = getGlobalOptions(program);
    const config = await loadConfig({ configPath: options.config });
    return createContext(config, options);
  };
}

async function main(): Promise<void> {
  try {
    // Create CLI program
    const program = createProgram(VERSION);

    // Create context factory for commands
    const createCtx = createContextFactory(program);

    // Register commands
    registerBuildCommand(program, createCtx);
    registerGitCommand(program, createCtx);
    registerDeployCommand(program, createCtx);
    registerServeCommand(program, createCtx);
    registerSessionCommand(program, createCtx);
    registerAwsCommand(program, createCtx);
    registerDashboardCommand(program, createCtx);

    // Add status command
    program
      .command('status')
      .description('Show project status')
      .action(async () => {
        const ctx = await createCtx();

        ctx.output.header('JIC CLI v2.0');
        ctx.output.keyValue('Project', ctx.config.project.name || 'Not configured');
        ctx.output.keyValue('Root', ctx.projectRoot);
        ctx.output.keyValue('Environment', ctx.env);
        ctx.output.keyValue('Modules', String(Object.keys(ctx.config.resolvedModules).length));
        ctx.output.newline();

        if (ctx.activeSession) {
          ctx.output.info(`Active session: ${ctx.activeSession.name}`);
        }

        if (Object.keys(ctx.config.resolvedModules).length > 0) {
          ctx.output.subheader('Modules');

          const rows: string[][] = Object.values(ctx.config.resolvedModules).map((m) => [
            m.name,
            m.type,
            m.aliases?.join(', ') || '-',
            m.resolvedBuild ? 'Yes' : '-',
            m.resolvedServe ? 'Yes' : '-',
          ]);

          ctx.output.table(rows, {
            head: ['Name', 'Type', 'Aliases', 'Build', 'Serve'],
          });
        }
      });

    // Add version command
    program
      .command('version')
      .description('Show version information')
      .action(() => {
        const output = new Output();
        output.log(`jic version ${VERSION}`);
        output.log(colors.muted('TypeScript rewrite - alpha'));
      });

    // Parse arguments
    await program.parseAsync(process.argv);

    // Show help if no command provided
    if (process.argv.length <= 2) {
      program.help();
    }
  } catch (error) {
    handleError(error, {
      verbose: process.env.JIC_VERBOSE === 'true',
      json: process.argv.includes('--json'),
    });
  }
}

main();
