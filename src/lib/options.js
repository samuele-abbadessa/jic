/**
 * Global CLI options
 *
 * Defines options available to all commands.
 */

/**
 * Setup global options on the program
 */
export function setupGlobalOptions(program) {
  program
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-e, --env <environment>', 'Environment (dev/prod)', 'dev')
    .option('--dry-run', 'Preview actions without executing')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--json', 'Output in JSON format')
    .option('-q, --quiet', 'Minimal output')
    .option('-V, --verbose', 'Detailed output')
    .option('--no-color', 'Disable colored output')
    .option('--fail-fast', 'Stop on first error')
    .option('--continue-on-error', 'Continue despite errors');
}

export default { setupGlobalOptions };
