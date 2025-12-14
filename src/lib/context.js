/**
 * Execution context for CLI commands
 *
 * Provides a unified interface for all commands to access
 * configuration, state, and common utilities.
 */

import { resolveModules, getModule, saveState } from './config.js';
import { output } from '../utils/output.js';

/**
 * Create an execution context
 */
export function createContext(config, options = {}) {
  const ctx = {
    // Configuration
    config,
    options,

    // Environment
    env: options.env || config.defaults?.environment || 'dev',
    projectRoot: config.projectRoot,
    isInitialized: config.isInitialized,

    // Output helpers
    output: createOutputHelper(options),

    // Module resolution
    resolveModules: (refs) => resolveModules(config, refs),
    getModule: (ref) => getModule(config, ref),

    // State management
    saveState: () => saveState(config),

    // AWS configuration
    getAwsConfig: (env) => getAwsConfigForEnv(config, env || ctx.env),

    // Execution options
    dryRun: options.dryRun || process.env.JIC_DRY_RUN === 'true',
    verbose: options.verbose || process.env.JIC_VERBOSE === 'true',
    quiet: options.quiet,
    json: options.json,
    yes: options.yes,

    // Fail strategy
    failStrategy: options.failFast ? 'fail-fast' :
                  options.continueOnError ? 'continue' :
                  config.defaults?.failStrategy || 'fail-fast'
  };

  return ctx;
}

/**
 * Create output helper based on options
 */
function createOutputHelper(options) {
  const isJson = options.json;
  const isQuiet = options.quiet;
  const isVerbose = options.verbose;

  return {
    // Standard output
    log: (...args) => !isQuiet && !isJson && console.log(...args),

    // Verbose output (only with --verbose)
    verbose: (...args) => isVerbose && !isJson && console.log(...args),

    // Error output
    error: (...args) => console.error(...args),

    // Warning output
    warn: (...args) => !isQuiet && console.warn(...args),

    // Success message
    success: (msg) => !isQuiet && !isJson && output.success(msg),

    // Info message
    info: (msg) => !isQuiet && !isJson && output.info(msg),

    // JSON output
    json: (data) => isJson && console.log(JSON.stringify(data, null, 2)),

    // Table output
    table: (data, columns) => !isQuiet && !isJson && output.table(data, columns),

    // Progress indicator
    progress: (msg) => !isQuiet && !isJson && output.progress(msg),

    // Newline
    newline: () => !isQuiet && !isJson && console.log()
  };
}

/**
 * Get AWS configuration for a specific environment
 */
function getAwsConfigForEnv(config, env) {
  const awsConfig = config.aws || {};
  const envConfig = awsConfig[env] || {};

  return {
    region: envConfig.region || awsConfig.region || 'eu-south-1',
    profile: envConfig.profile || awsConfig.profile,
    accountId: envConfig.accountId,
    ecsCluster: envConfig.ecsCluster,
    ecrRegistry: envConfig.ecrRegistry
  };
}

export default { createContext };
