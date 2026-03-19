/**
 * CLI setup for JIC CLI
 *
 * Configures Commander.js with global options and command registration.
 */

import { Command } from 'commander';
import type { GlobalOptions } from './core/types/execution.js';

/**
 * Create and configure the CLI program
 */
export function createProgram(version: string): Command {
  const program = new Command();

  program
    .name('jic')
    .description('Multi-module project management CLI for microservices')
    .version(version, '-v, --version', 'Output the current version');

  // Global options
  program
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-e, --env <environment>', 'Environment (dev/staging/prod)', 'dev')
    .option('--dry-run', 'Preview actions without executing')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--json', 'Output in JSON format')
    .option('-q, --quiet', 'Minimal output')
    .option('-V, --verbose', 'Detailed output')
    .option('--no-color', 'Disable colored output')
    .option('--fail-fast', 'Stop on first error')
    .option('--continue-on-error', 'Continue despite errors');

  return program;
}

/**
 * Extract global options from parsed program
 */
export function getGlobalOptions(program: Command): GlobalOptions {
  const opts = program.opts();

  return {
    config: opts.config as string | undefined,
    env: (opts.env as 'dev' | 'staging' | 'prod') ?? 'dev',
    dryRun: opts.dryRun ?? false,
    yes: opts.yes ?? false,
    json: opts.json ?? false,
    quiet: opts.quiet ?? false,
    verbose: opts.verbose ?? false,
    noColor: opts.color === false, // Commander uses --no-color -> color: false
    failFast: opts.failFast ?? false,
    continueOnError: opts.continueOnError ?? false,
  };
}
