#!/usr/bin/env node

/**
 * JIC CLI - JoyInCloud Development Workflow CLI
 *
 * A comprehensive CLI tool for managing multi-module microservices projects.
 * Handles git operations, builds, deployments, and AWS resource management.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { program } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import commands
import { registerGitCommands } from '../src/commands/git.js';
import { registerBuildCommands } from '../src/commands/build.js';
import { registerDeployCommands } from '../src/commands/deploy.js';
import { registerAwsCommands } from '../src/commands/aws.js';
import { registerSessionCommands } from '../src/commands/session.js';
import { registerConfigCommands } from '../src/commands/config.js';
import { registerStatusCommands } from '../src/commands/status.js';

// Import core
import { loadConfig } from '../src/lib/config.js';
import { setupGlobalOptions } from '../src/lib/options.js';
import { handleError } from '../src/utils/error.js';
import { createContext } from '../src/lib/context.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

async function main() {
  try {
    // Setup program
    program
      .name('jic')
      .description('JoyInCloud Development Workflow CLI')
      .version(pkg.version, '-v, --version', 'Output the current version');

    // Setup global options
    setupGlobalOptions(program);

    // Load configuration
    const config = await loadConfig(program.opts());

    // Create execution context
    const ctx = createContext(config, program.opts());

    // Register command groups
    registerGitCommands(program, ctx);
    registerBuildCommands(program, ctx);
    registerDeployCommands(program, ctx);
    registerAwsCommands(program, ctx);
    registerSessionCommands(program, ctx);
    registerConfigCommands(program, ctx);
    registerStatusCommands(program, ctx);

    // Parse arguments
    await program.parseAsync(process.argv);

    // Show help if no command provided
    if (process.argv.length <= 2) {
      program.help();
    }
  } catch (error) {
    handleError(error);
    process.exit(1);
  }
}

main();
