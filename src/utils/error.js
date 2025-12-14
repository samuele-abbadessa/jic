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

/**
 * Handle and format errors for output
 */
export function handleError(error) {
  // Custom JIC errors
  if (error instanceof JicError) {
    console.error(`\n${logSymbols.error} ${chalk.red(error.message)}`);

    if (error.module) {
      console.error(chalk.gray(`   Module: ${error.module}`));
    }

    if (error.service) {
      console.error(chalk.gray(`   Service: ${error.service}`));
    }

    if (process.env.JIC_VERBOSE === 'true' && error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }

    return;
  }

  // Command execution errors (from execa)
  if (error.command) {
    console.error(`\n${logSymbols.error} ${chalk.red('Command failed:')}`);
    console.error(chalk.gray(`   ${error.command}`));

    if (error.stderr) {
      console.error(chalk.red('\nError output:'));
      console.error(error.stderr);
    }

    if (error.stdout && process.env.JIC_VERBOSE === 'true') {
      console.error(chalk.gray('\nStandard output:'));
      console.error(error.stdout);
    }

    return;
  }

  // Generic errors
  console.error(`\n${logSymbols.error} ${chalk.red(error.message || error)}`);

  if (process.env.JIC_VERBOSE === 'true' && error.stack) {
    console.error(chalk.gray('\nStack trace:'));
    console.error(chalk.gray(error.stack));
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
  handleError,
  withErrorHandling,
  assert
};
