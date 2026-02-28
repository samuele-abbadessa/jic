/**
 * Shell execution utilities for JIC CLI
 *
 * Provides typed wrappers around execa for executing shell commands
 * with support for:
 * - Timeout handling
 * - Dry run mode
 * - Module-scoped execution
 * - Parallel/sequential execution
 */

import { execa, type ExecaError, type Options as ExecaOptions } from 'execa';
import type { ResolvedModule } from '../types/module.js';
import { createSpinner } from './output.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for executing a shell command
 */
export interface ExecOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** Suppress stdout/stderr */
  silent?: boolean;
  /** Show verbose output */
  verbose?: boolean;
  /** Dry run mode - don't actually execute */
  dryRun?: boolean;
  /** Input to pass to the command */
  input?: string;
}

/**
 * Result of executing a shell command
 */
export interface ExecResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether command succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  duration: number;
  /** The command that was executed */
  command: string;
}

/**
 * Options for executing with a spinner
 */
export interface SpinnerExecOptions extends ExecOptions {
  /** Spinner text while running */
  text?: string;
  /** Success message */
  successText?: string;
  /** Failure message */
  failureText?: string;
}

// ============================================================================
// Core Execution Functions
// ============================================================================

/**
 * Execute a shell command
 */
export async function exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const startTime = Date.now();

  // Dry run mode
  if (options.dryRun) {
    return {
      exitCode: 0,
      stdout: `[dry-run] ${command}`,
      stderr: '',
      success: true,
      duration: 0,
      command,
    };
  }

  const execaOptions: ExecaOptions = {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    timeout: options.timeout,
    shell: true,
    reject: false,
    stdin: options.input ? 'pipe' : 'inherit',
    stdout: options.silent ? 'pipe' : 'inherit',
    stderr: options.silent ? 'pipe' : 'inherit',
  };

  try {
    const result = await execa(command, execaOptions);
    const duration = Date.now() - startTime;

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      success: result.exitCode === 0,
      duration,
      command,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const execaError = error as ExecaError;

    return {
      exitCode: execaError.exitCode ?? 1,
      stdout: execaError.stdout ?? '',
      stderr: execaError.stderr ?? execaError.message,
      success: false,
      duration,
      command,
    };
  }
}

/**
 * Execute a command and capture output (always silent)
 */
export async function execCapture(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  return exec(command, { ...options, silent: true });
}

/**
 * Error class for failed command execution.
 * Includes stdout, stderr, command, and exit code for debugging.
 */
export class ExecError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  readonly command: string;
  readonly exitCode: number;

  constructor(result: ExecResult) {
    super(`Command failed with exit code ${result.exitCode}`);
    this.name = 'ExecError';
    this.stderr = result.stderr;
    this.stdout = result.stdout;
    this.command = result.command;
    this.exitCode = result.exitCode;
  }
}

/**
 * Execute a command and throw if it fails.
 * Use this when you need to ensure the command succeeds and want to handle
 * failures in a catch block with full error details (stdout, stderr, exitCode).
 */
export async function execOrThrow(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(command, options);
  if (!result.success) {
    throw new ExecError(result);
  }
  return result;
}

/**
 * Execute a command with a spinner
 */
export async function execWithSpinner(
  command: string,
  options: SpinnerExecOptions = {}
): Promise<ExecResult> {
  const spinner = createSpinner(options.text ?? command);

  if (options.dryRun) {
    spinner.info(`[dry-run] ${command}`);
    return {
      exitCode: 0,
      stdout: `[dry-run] ${command}`,
      stderr: '',
      success: true,
      duration: 0,
      command,
    };
  }

  spinner.start();

  try {
    const result = await exec(command, { ...options, silent: true });

    if (result.success) {
      spinner.succeed(options.successText ?? options.text ?? 'Done');
    } else {
      spinner.fail(options.failureText ?? `Failed: ${command}`);
    }

    return result;
  } catch (error) {
    spinner.fail(options.failureText ?? `Failed: ${command}`);
    throw error;
  }
}

// ============================================================================
// Module-Scoped Execution
// ============================================================================

/**
 * Execute a command in a module's directory
 */
export async function execInModule(
  module: ResolvedModule,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  return exec(command, {
    ...options,
    cwd: module.absolutePath,
  });
}

/**
 * Execute a command in multiple modules
 */
export async function execInModules(
  modules: ResolvedModule[],
  command: string,
  options: ExecOptions & { parallel?: boolean } = {}
): Promise<Map<string, ExecResult>> {
  const results = new Map<string, ExecResult>();

  if (options.parallel) {
    const promises = modules.map(async (module) => {
      const result = await execInModule(module, command, options);
      return { name: module.name, result };
    });

    const settled = await Promise.all(promises);
    for (const { name, result } of settled) {
      results.set(name, result);
    }
  } else {
    for (const module of modules) {
      const result = await execInModule(module, command, options);
      results.set(module.name, result);
    }
  }

  return results;
}

// ============================================================================
// Git Utilities
// ============================================================================

/**
 * Get the current git branch in a directory
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  const result = await execCapture('git rev-parse --abbrev-ref HEAD', { cwd });
  return result.success ? result.stdout.trim() : null;
}

/**
 * Get the current git commit hash
 */
export async function getGitCommit(cwd: string, short = true): Promise<string | null> {
  const flag = short ? '--short' : '';
  const result = await execCapture(`git rev-parse ${flag} HEAD`, { cwd });
  return result.success ? result.stdout.trim() : null;
}

/**
 * Check if a git branch exists (local or remote)
 */
export async function gitBranchExists(
  cwd: string,
  branch: string,
  remote = false
): Promise<boolean> {
  const ref = remote ? `refs/remotes/${branch}` : `refs/heads/${branch}`;
  const result = await execCapture(`git show-ref --verify --quiet ${ref}`, { cwd });
  return result.success;
}

/**
 * Get git status information
 */
export interface GitStatus {
  /** Is working tree clean */
  clean: boolean;
  /** Number of modified files */
  modified: number;
  /** Number of added/new files */
  added: number;
  /** Number of deleted files */
  deleted: number;
  /** Number of untracked files */
  untracked: number;
  /** Current branch */
  branch: string | null;
  /** Ahead/behind tracking */
  ahead: number;
  behind: number;
}

/**
 * Get detailed git status
 */
export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const [branchResult, statusResult] = await Promise.all([
    execCapture('git rev-parse --abbrev-ref HEAD', { cwd }),
    execCapture('git status --porcelain', { cwd }),
  ]);

  const branch = branchResult.success ? branchResult.stdout.trim() : null;
  const lines = statusResult.success ? statusResult.stdout.trim().split('\n').filter(Boolean) : [];

  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  for (const line of lines) {
    const status = line.substring(0, 2);
    if (status.includes('M')) modified++;
    if (status.includes('A')) added++;
    if (status.includes('D')) deleted++;
    if (status.startsWith('??')) untracked++;
  }

  // Get ahead/behind info
  let ahead = 0;
  let behind = 0;

  if (branch) {
    const aheadBehindResult = await execCapture(
      `git rev-list --left-right --count HEAD...@{upstream}`,
      { cwd }
    );
    if (aheadBehindResult.success) {
      const [a, b] = aheadBehindResult.stdout.trim().split(/\s+/);
      ahead = parseInt(a, 10) || 0;
      behind = parseInt(b, 10) || 0;
    }
  }

  return {
    clean: lines.length === 0,
    modified,
    added,
    deleted,
    untracked,
    branch,
    ahead,
    behind,
  };
}

/**
 * Check if there are uncommitted changes
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await execCapture('git status --porcelain', { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Get list of commits between two refs
 */
export async function getCommitsBetween(
  cwd: string,
  from: string,
  to: string
): Promise<string[]> {
  const result = await execCapture(
    `git log --oneline ${from}..${to}`,
    { cwd }
  );

  if (!result.success) return [];
  return result.stdout.trim().split('\n').filter(Boolean);
}

// ============================================================================
// Process Management Utilities
// ============================================================================

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process gracefully (SIGTERM then SIGKILL)
 */
export async function killProcess(
  pid: number,
  options: { timeout?: number; signal?: NodeJS.Signals } = {}
): Promise<boolean> {
  const { timeout = 10000, signal = 'SIGTERM' } = options;

  if (!isProcessRunning(pid)) {
    return true;
  }

  try {
    process.kill(pid, signal);

    // Wait for process to exit
    const startTime = Date.now();
    while (isProcessRunning(pid) && Date.now() - startTime < timeout) {
      await sleep(100);
    }

    // Force kill if still running
    if (isProcessRunning(pid)) {
      process.kill(pid, 'SIGKILL');
      await sleep(100);
    }

    return !isProcessRunning(pid);
  } catch {
    return false;
  }
}

/**
 * Kill a process group
 */
export async function killProcessGroup(
  pgid: number,
  options: { timeout?: number } = {}
): Promise<boolean> {
  const { timeout = 10000 } = options;

  try {
    // Send SIGTERM to process group (negative pid)
    process.kill(-pgid, 'SIGTERM');

    // Wait for graceful shutdown
    const startTime = Date.now();
    while (isProcessRunning(pgid) && Date.now() - startTime < timeout) {
      await sleep(100);
    }

    // Force kill if still running
    if (isProcessRunning(pgid)) {
      process.kill(-pgid, 'SIGKILL');
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a given duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<boolean> {
  const { timeout = 30000, interval = 500 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await sleep(interval);
  }

  return false;
}

/**
 * Wait for a health check to pass
 */
export async function waitForHealthy(
  healthCheck: string,
  options: { timeout?: number; interval?: number; cwd?: string } = {}
): Promise<boolean> {
  const { timeout = 120000, interval = 2000, cwd } = options;

  return waitFor(
    async () => {
      const result = await execCapture(healthCheck, { cwd, timeout: 5000 });
      return result.success;
    },
    { timeout, interval }
  );
}
