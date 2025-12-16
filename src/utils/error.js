/**
 * Error handling utilities
 */

import chalk from 'chalk';
import logSymbols from 'log-symbols';

/**
 * Custom error classes
 */
export class JicError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'JicError';
    this.code = code;
  }
}

export class ConfigError extends JicError {
  constructor(message) {
    super(message, 2);
    this.name = 'ConfigError';
  }
}

export class BuildError extends JicError {
  constructor(message, module = null) {
    super(message, 3);
    this.name = 'BuildError';
    this.module = module;
  }
}

export class DeployError extends JicError {
  constructor(message, module = null) {
    super(message, 4);
    this.name = 'DeployError';
    this.module = module;
  }
}

export class AwsError extends JicError {
  constructor(message, service = null) {
    super(message, 5);
    this.name = 'AwsError';
    this.service = service;
  }
}

export class GitError extends JicError {
  constructor(message, module = null) {
    super(message, 6);
    this.name = 'GitError';
    this.module = module;
  }
}

export class ServeError extends JicError {
  constructor(message, service = null) {
    super(message, 7);
    this.name = 'ServeError';
    this.service = service;
  }
}

/**
 * Check if verbose mode is enabled
 */
function isVerbose() {
  return process.env.JIC_VERBOSE === 'true';
}

/**
 * Handle and format errors for output
 */
export function handleError(error) {
  const verbose = isVerbose();

  // Custom JIC errors
  if (error instanceof JicError) {
    console.error(`\n${logSymbols.error} ${chalk.red(error.message)}`);

    if (error.module) {
      console.error(chalk.gray(`   Module: ${error.module}`));
    }

    if (error.service) {
      console.error(chalk.gray(`   Service: ${error.service}`));
    }

    // Show cause/original error if available
    if (verbose && error.cause) {
      console.error(chalk.gray('\nCaused by:'));
      console.error(chalk.gray(`   ${error.cause.message || error.cause}`));
      if (error.cause.stderr) {
        console.error(chalk.yellow('\nError output:'));
        console.error(error.cause.stderr);
      }
    }

    if (verbose && error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }

    return;
  }

  // Command execution errors (from execa)
  if (error.command) {
    console.error(`\n${logSymbols.error} ${chalk.red('Command failed:')}`);
    console.error(chalk.gray(`   ${error.command}`));

    if (error.exitCode !== undefined) {
      console.error(chalk.gray(`   Exit code: ${error.exitCode}`));
    }

    if (error.stderr) {
      console.error(chalk.yellow('\nError output:'));
      console.error(error.stderr);
    }

    if (verbose) {
      if (error.stdout) {
        console.error(chalk.gray('\nStandard output:'));
        console.error(error.stdout);
      }

      if (error.cwd) {
        console.error(chalk.gray(`\nWorking directory: ${error.cwd}`));
      }

      if (error.stack) {
        console.error(chalk.gray('\nStack trace:'));
        console.error(chalk.gray(error.stack));
      }
    }

    return;
  }

  // Generic errors
  console.error(`\n${logSymbols.error} ${chalk.red(error.message || error)}`);

  if (verbose) {
    if (error.cause) {
      console.error(chalk.gray('\nCaused by:'));
      console.error(chalk.gray(`   ${error.cause.message || error.cause}`));
    }

    if (error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }
  }
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      handleError(error);
      process.exit(error.code || 1);
    }
  };
}

/**
 * Assert a condition, throwing if false
 */
export function assert(condition, message, ErrorClass = JicError) {
  if (!condition) {
    throw new ErrorClass(message);
  }
}

export default {
  JicError,
  ConfigError,
  BuildError,
  DeployError,
  AwsError,
  GitError,
  ServeError,
  handleError,
  withErrorHandling,
  assert
};
