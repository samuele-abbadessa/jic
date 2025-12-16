/**
 * Error handling for JIC CLI
 *
 * Custom error classes with exit codes and structured error information.
 * Each error type has a specific exit code for scripting support.
 */

import chalk from 'chalk';

// ============================================================================
// Exit Codes
// ============================================================================

/**
 * Standard exit codes for JIC CLI
 */
export const ExitCodes = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  CONFIG_ERROR: 2,
  BUILD_ERROR: 3,
  DEPLOY_ERROR: 4,
  AWS_ERROR: 5,
  GIT_ERROR: 6,
  SERVE_ERROR: 7,
  SESSION_ERROR: 8,
  VALIDATION_ERROR: 9,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

// ============================================================================
// Base Error Class
// ============================================================================

/**
 * Base error class for all JIC errors
 */
export class JicError extends Error {
  /** Exit code for this error */
  readonly exitCode: ExitCode;

  /** Additional context for the error */
  readonly context?: Record<string, unknown>;

  /** Original error that caused this */
  readonly cause?: Error;

  constructor(
    message: string,
    options: {
      exitCode?: ExitCode;
      context?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'JicError';
    this.exitCode = options.exitCode ?? ExitCodes.GENERAL_ERROR;
    this.context = options.context;
    this.cause = options.cause;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Format error for display
   */
  format(verbose = false): string {
    let output = chalk.red(`Error: ${this.message}`);

    if (this.context && verbose) {
      output += '\n\nContext:';
      for (const [key, value] of Object.entries(this.context)) {
        output += `\n  ${chalk.gray(key)}: ${String(value)}`;
      }
    }

    if (this.cause && verbose) {
      output += `\n\nCaused by: ${this.cause.message}`;
      if (this.cause.stack) {
        output += `\n${chalk.gray(this.cause.stack)}`;
      }
    }

    return output;
  }

  /**
   * Convert to JSON for --json output
   */
  toJSON(): Record<string, unknown> {
    return {
      error: true,
      type: this.name,
      message: this.message,
      exitCode: this.exitCode,
      context: this.context,
      cause: this.cause?.message,
    };
  }
}

// ============================================================================
// Specific Error Classes
// ============================================================================

/**
 * Configuration error
 */
export class ConfigError extends JicError {
  constructor(message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, {
      exitCode: ExitCodes.CONFIG_ERROR,
      context,
      cause,
    });
    this.name = 'ConfigError';
  }
}

/**
 * Build error
 */
export class BuildError extends JicError {
  /** Module that failed to build */
  readonly moduleName?: string;

  constructor(message: string, moduleName?: string, cause?: Error) {
    super(message, {
      exitCode: ExitCodes.BUILD_ERROR,
      context: moduleName ? { module: moduleName } : undefined,
      cause,
    });
    this.name = 'BuildError';
    this.moduleName = moduleName;
  }
}

/**
 * Deploy error
 */
export class DeployError extends JicError {
  /** Module that failed to deploy */
  readonly moduleName?: string;

  /** Environment that was being deployed to */
  readonly environment?: string;

  constructor(
    message: string,
    options: { moduleName?: string; environment?: string; cause?: Error } = {}
  ) {
    super(message, {
      exitCode: ExitCodes.DEPLOY_ERROR,
      context: {
        module: options.moduleName,
        environment: options.environment,
      },
      cause: options.cause,
    });
    this.name = 'DeployError';
    this.moduleName = options.moduleName;
    this.environment = options.environment;
  }
}

/**
 * AWS error
 */
export class AwsError extends JicError {
  /** AWS service that failed */
  readonly service?: string;

  /** AWS operation that failed */
  readonly operation?: string;

  constructor(
    message: string,
    options: { service?: string; operation?: string; cause?: Error } = {}
  ) {
    super(message, {
      exitCode: ExitCodes.AWS_ERROR,
      context: {
        service: options.service,
        operation: options.operation,
      },
      cause: options.cause,
    });
    this.name = 'AwsError';
    this.service = options.service;
    this.operation = options.operation;
  }
}

/**
 * Git error
 */
export class GitError extends JicError {
  /** Module where git operation failed */
  readonly moduleName?: string;

  /** Git command that failed */
  readonly command?: string;

  constructor(
    message: string,
    options: { moduleName?: string; command?: string; cause?: Error } = {}
  ) {
    super(message, {
      exitCode: ExitCodes.GIT_ERROR,
      context: {
        module: options.moduleName,
        command: options.command,
      },
      cause: options.cause,
    });
    this.name = 'GitError';
    this.moduleName = options.moduleName;
    this.command = options.command;
  }
}

/**
 * Serve error
 */
export class ServeError extends JicError {
  /** Module that failed to serve */
  readonly moduleName?: string;

  constructor(message: string, moduleName?: string, cause?: Error) {
    super(message, {
      exitCode: ExitCodes.SERVE_ERROR,
      context: moduleName ? { module: moduleName } : undefined,
      cause,
    });
    this.name = 'ServeError';
    this.moduleName = moduleName;
  }
}

/**
 * Session error
 */
export class SessionError extends JicError {
  /** Session name */
  readonly sessionName?: string;

  constructor(message: string, sessionName?: string, cause?: Error) {
    super(message, {
      exitCode: ExitCodes.SESSION_ERROR,
      context: sessionName ? { session: sessionName } : undefined,
      cause,
    });
    this.name = 'SessionError';
    this.sessionName = sessionName;
  }
}

/**
 * Validation error
 */
export class ValidationError extends JicError {
  /** Validation errors */
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message, {
      exitCode: ExitCodes.VALIDATION_ERROR,
      context: { errors },
    });
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

// ============================================================================
// Error Handler
// ============================================================================

/**
 * Global error handler
 */
export function handleError(error: unknown, options: { verbose?: boolean; json?: boolean } = {}): never {
  const { verbose = false, json = false } = options;

  if (error instanceof JicError) {
    if (json) {
      console.error(JSON.stringify(error.toJSON(), null, 2));
    } else {
      console.error(error.format(verbose));
    }
    process.exit(error.exitCode);
  }

  // Handle unknown errors
  if (error instanceof Error) {
    if (json) {
      console.error(
        JSON.stringify(
          {
            error: true,
            type: 'UnknownError',
            message: error.message,
            exitCode: ExitCodes.GENERAL_ERROR,
            stack: verbose ? error.stack : undefined,
          },
          null,
          2
        )
      );
    } else {
      console.error(chalk.red(`Error: ${error.message}`));
      if (verbose && error.stack) {
        console.error(chalk.gray(error.stack));
      }
    }
    process.exit(ExitCodes.GENERAL_ERROR);
  }

  // Handle non-Error throws
  console.error(chalk.red(`Unknown error: ${String(error)}`));
  process.exit(ExitCodes.GENERAL_ERROR);
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: { verbose?: boolean; json?: boolean } = {}
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      handleError(error, options);
    }
  };
}

// ============================================================================
// Error Utilities
// ============================================================================

/**
 * Check if an error is a specific JIC error type
 */
export function isJicError(error: unknown): error is JicError {
  return error instanceof JicError;
}

/**
 * Check if error indicates the operation was cancelled
 */
export function isCancelledError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('cancelled') ||
      error.message.includes('SIGINT') ||
      error.message.includes('interrupted')
    );
  }
  return false;
}

/**
 * Wrap an error with additional context
 */
export function wrapError(
  error: unknown,
  message: string,
  ErrorClass: typeof JicError = JicError
): JicError {
  if (error instanceof Error) {
    return new ErrorClass(message, { cause: error } as unknown as undefined);
  }
  return new ErrorClass(`${message}: ${String(error)}`);
}
