/**
 * Shell execution utilities
 *
 * Provides consistent command execution across the CLI.
 */

import { execa } from 'execa';
import { output, createSpinner, formatDuration } from './output.js';

/**
 * Execute a shell command
 *
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} - Command result
 */
export async function exec(command, options = {}) {
  const {
    cwd = process.cwd(),
    env = {},
    stdin = 'inherit',  // Default to 'inherit' to allow interactive prompts (passwords, MFA, etc.)
    silent = false,
    dryRun = false,
    verbose = false,
    spinner = null,
    timeout = 0
  } = options;

  // Dry run mode
  if (dryRun) {
    if (!silent) {
      output.info(`[dry-run] Would execute: ${command}`);
      if (cwd !== process.cwd()) {
        console.log(output.muted(`  in: ${cwd}`));
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, dryRun: true };
  }

  // Log command in verbose mode
  if (verbose && !silent) {
    console.log(output.muted(`$ ${command}`));
  }

  const startTime = Date.now();

  try {
    const result = await execa(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdin,
      timeout: timeout > 0 ? timeout : undefined,
      all: true
    });

    const duration = Date.now() - startTime;

    if (verbose && !silent) {
      console.log(output.muted(`  completed in ${formatDuration(duration)}`));
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      all: result.all,
      exitCode: result.exitCode,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    error.duration = duration;
    throw error;
  }
}

/**
 * Execute a command with a spinner
 */
export async function execWithSpinner(command, message, options = {}) {
  const spinner = createSpinner(message);

  if (!options.silent && !options.dryRun) {
    spinner.start();
  }

  try {
    const result = await exec(command, { ...options, spinner });

    if (!options.silent && !options.dryRun) {
      spinner.succeed(`${message} ${output.muted(`(${formatDuration(result.duration)})`)}`);
    }

    return result;
  } catch (error) {
    if (!options.silent) {
      spinner.fail(message);
    }
    throw error;
  }
}

/**
 * Execute multiple commands in sequence
 */
export async function execSequence(commands, options = {}) {
  const results = [];

  for (const cmd of commands) {
    const command = typeof cmd === 'string' ? cmd : cmd.command;
    const cmdOptions = typeof cmd === 'string' ? {} : cmd.options || {};

    const result = await exec(command, { ...options, ...cmdOptions });
    results.push(result);
  }

  return results;
}

/**
 * Execute multiple commands in parallel
 */
export async function execParallel(commands, options = {}) {
  const { maxConcurrency = 4 } = options;

  const results = [];
  const pending = [...commands];

  while (pending.length > 0) {
    const batch = pending.splice(0, maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(cmd => {
        const command = typeof cmd === 'string' ? cmd : cmd.command;
        const cmdOptions = typeof cmd === 'string' ? {} : cmd.options || {};
        return exec(command, { ...options, ...cmdOptions }).catch(e => e);
      })
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Execute a command in a specific module directory
 */
export async function execInModule(module, command, options = {}) {
  return exec(command, {
    ...options,
    cwd: module.absolutePath || module.directory
  });
}

/**
 * Execute a command in multiple modules
 */
export async function execInModules(modules, command, options = {}) {
  const { parallel = false, ...execOptions } = options;

  if (parallel) {
    return Promise.all(
      modules.map(module =>
        execInModule(module, command, execOptions)
          .then(result => ({ module, result, success: true }))
          .catch(error => ({ module, error, success: false }))
      )
    );
  }

  const results = [];
  for (const module of modules) {
    try {
      const result = await execInModule(module, command, execOptions);
      results.push({ module, result, success: true });
    } catch (error) {
      results.push({ module, error, success: false });
      if (options.failFast !== false) {
        throw error;
      }
    }
  }

  return results;
}

/**
 * Check if a command exists
 */
export async function commandExists(command) {
  try {
    await exec(`command -v ${command}`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git branch in a directory
 */
export async function getGitBranch(cwd = process.cwd()) {
  try {
    const result = await exec('git rev-parse --abbrev-ref HEAD', { cwd, silent: true });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get git status for a directory
 */
export async function getGitStatus(cwd = process.cwd()) {
  try {
    const result = await exec('git status --porcelain', { cwd, silent: true });
    const lines = result.stdout.trim().split('\n').filter(Boolean);

    return {
      clean: lines.length === 0,
      modified: lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length,
      added: lines.filter(l => l.startsWith('A ') || l.startsWith('??')).length,
      deleted: lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length,
      files: lines
    };
  } catch {
    return { clean: true, modified: 0, added: 0, deleted: 0, files: [] };
  }
}

/**
 * Get the current git commit hash
 */
export async function getGitCommit(cwd = process.cwd(), short = true) {
  try {
    const flag = short ? '--short' : '';
    const result = await exec(`git rev-parse ${flag} HEAD`, { cwd, silent: true });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export default {
  exec,
  execWithSpinner,
  execSequence,
  execParallel,
  execInModule,
  execInModules,
  commandExists,
  getGitBranch,
  getGitStatus,
  getGitCommit
};
