/**
 * Clean Command
 *
 * Multi-module cleanup for build artifacts, dependencies, and Docker.
 *
 * Examples:
 *   jic clean                    # Clean build artifacts
 *   jic clean --deps             # Also clean node_modules, .m2 cache
 *   jic clean --docker           # Prune Docker images/containers
 *   jic clean @backend           # Clean specific modules
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { withErrorHandling } from '../core/errors/index.js';
import { exec } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// Clean Command Registration
// ============================================================================

interface CleanOptions {
  deps?: boolean;
  docker?: boolean;
  deep?: boolean;
  force?: boolean;
}

export function registerCleanCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('clean')
    .description('Clean build artifacts across modules')
    .argument('[modules...]', 'Modules to clean (default: all)')
    .option('-d, --deps', 'Also clean dependencies (node_modules, .m2 cache)')
    .option('--docker', 'Prune Docker images and containers')
    .option('--deep', 'Deep clean (includes deps + docker)')
    .option('-f, --force', 'Skip confirmation prompts')
    .action(
      withErrorHandling(async (modules: string[], options: CleanOptions) => {
        const ctx = await createContext();
        await cleanModules(ctx, modules, options);
      })
    );
}

// ============================================================================
// Clean Implementation
// ============================================================================

interface CleanResult {
  module: string;
  cleaned: string[];
  freedSpace: number;
  errors: string[];
}

/**
 * Get directory size in bytes
 */
async function getDirSize(path: string): Promise<number> {
  try {
    const result = await exec(`du -sb "${path}" 2>/dev/null | cut -f1`, { silent: true });
    return parseInt(result.stdout?.trim() || '0', 10);
  } catch {
    return 0;
  }
}

/**
 * Check if directory exists
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    await exec(`test -d "${path}"`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format bytes to human-readable
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Clean patterns for different module types
 */
const CLEAN_PATTERNS: Record<string, string[]> = {
  'java-service': [
    'target',
  ],
  'flux-client': [
    'target',
  ],
  frontend: [
    'target',
    'dist',
    '.angular/cache',
    'node_modules/.cache',
  ],
  'node-service': [
    'dist',
    'build',
    'node_modules/.cache',
  ],
  'lambda-layer': [
    'nodejs/node_modules',
  ],
  'lambda-functions': [
    '*/node_modules',
    '*/*.zip',
  ],
};

/**
 * Dependency patterns to clean
 */
const DEP_PATTERNS: Record<string, string[]> = {
  'java-service': [],  // .m2 is global
  'flux-client': [],
  frontend: ['node_modules'],
  'node-service': ['node_modules'],
  'lambda-layer': [],
  'lambda-functions': [],
};

async function cleanModules(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: CleanOptions
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);
  const includeDeps = options.deps || options.deep;
  const includeDocker = options.docker || options.deep;

  ctx.output.header('Clean');

  // Show what will be cleaned
  const cleanTypes: string[] = ['build artifacts'];
  if (includeDeps) cleanTypes.push('dependencies');
  if (includeDocker) cleanTypes.push('Docker');
  ctx.output.keyValue('Cleaning', cleanTypes.join(', '));
  ctx.output.keyValue('Modules', modules.length.toString());
  ctx.output.newline();

  const results: CleanResult[] = [];
  let totalFreed = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: scanning`);
    spinner.start();

    const result: CleanResult = {
      module: module.name,
      cleaned: [],
      freedSpace: 0,
      errors: [],
    };

    // Get patterns for this module type
    const patterns = CLEAN_PATTERNS[module.type] ?? [];
    const depPatterns = includeDeps ? (DEP_PATTERNS[module.type] ?? []) : [];
    const allPatterns = [...patterns, ...depPatterns];

    if (allPatterns.length === 0) {
      spinner.info(`${module.name}: nothing to clean`);
      continue;
    }

    spinner.text = `${module.name}: cleaning`;

    for (const pattern of allPatterns) {
      const fullPath = `${module.absolutePath}/${pattern}`;

      // Handle glob patterns
      if (pattern.includes('*')) {
        try {
          const globResult = await exec(`ls -d ${fullPath} 2>/dev/null || true`, { silent: true });
          const paths = globResult.stdout?.trim().split('\n').filter(Boolean) ?? [];

          for (const p of paths) {
            const size = await getDirSize(p);
            if (size > 0) {
              if (!ctx.dryRun) {
                await exec(`rm -rf "${p}"`, { silent: true });
              }
              result.cleaned.push(pattern);
              result.freedSpace += size;
            }
          }
        } catch {
          // Glob didn't match anything
        }
      } else {
        // Direct path
        if (await dirExists(fullPath)) {
          const size = await getDirSize(fullPath);

          if (ctx.dryRun) {
            result.cleaned.push(pattern);
            result.freedSpace += size;
          } else {
            try {
              await exec(`rm -rf "${fullPath}"`, { silent: true });
              result.cleaned.push(pattern);
              result.freedSpace += size;
            } catch (error) {
              result.errors.push(`Failed to clean ${pattern}: ${error}`);
            }
          }
        }
      }
    }

    if (result.cleaned.length > 0) {
      totalFreed += result.freedSpace;
      const prefix = ctx.dryRun ? '[dry-run] Would clean' : 'Cleaned';
      spinner.succeed(
        `${module.name}: ${prefix} ${result.cleaned.length} items (${formatBytes(result.freedSpace)})`
      );
      results.push(result);
    } else {
      spinner.info(`${module.name}: already clean`);
    }
  }

  // Clean global dependencies if --deps
  if (includeDeps) {
    ctx.output.newline();
    const m2Spinner = ctx.output.spinner('Cleaning Maven cache (.m2/repository)');
    m2Spinner.start();

    try {
      const m2Path = `${process.env.HOME}/.m2/repository`;
      if (await dirExists(m2Path)) {
        const size = await getDirSize(m2Path);

        if (ctx.dryRun) {
          m2Spinner.info(`[dry-run] Would clean Maven cache (${formatBytes(size)})`);
        } else {
          // Only clean old/unused artifacts, not everything
          // This removes lastUpdated files older than 30 days
          await exec(
            `find "${m2Path}" -name "*.lastUpdated" -mtime +30 -delete 2>/dev/null || true`,
            { silent: true }
          );
          // Remove empty directories
          await exec(
            `find "${m2Path}" -type d -empty -delete 2>/dev/null || true`,
            { silent: true }
          );
          m2Spinner.succeed('Cleaned Maven cache (old artifacts)');
        }
      } else {
        m2Spinner.info('Maven cache not found');
      }
    } catch {
      m2Spinner.warn('Failed to clean Maven cache');
    }
  }

  // Clean Docker if --docker
  if (includeDocker) {
    ctx.output.newline();
    await cleanDocker(ctx);
  }

  // Summary
  ctx.output.newline();
  if (results.length > 0) {
    const verb = ctx.dryRun ? 'Would free' : 'Freed';
    ctx.output.success(`${verb} ${formatBytes(totalFreed)} across ${results.length} modules`);
  } else {
    ctx.output.info('Nothing to clean');
  }
}

async function cleanDocker(ctx: IExecutionContext): Promise<void> {
  const spinner = ctx.output.spinner('Cleaning Docker');
  spinner.start();

  try {
    if (ctx.dryRun) {
      // Show what would be cleaned
      const danglingResult = await exec(
        'docker images -f "dangling=true" -q | wc -l',
        { silent: true }
      );
      const danglingCount = parseInt(danglingResult.stdout?.trim() || '0', 10);

      const stoppedResult = await exec(
        'docker ps -a -f "status=exited" -q | wc -l',
        { silent: true }
      );
      const stoppedCount = parseInt(stoppedResult.stdout?.trim() || '0', 10);

      spinner.info(
        `[dry-run] Would remove ${danglingCount} dangling images, ${stoppedCount} stopped containers`
      );
      return;
    }

    // Remove stopped containers
    await exec('docker container prune -f', { silent: true });

    // Remove dangling images
    await exec('docker image prune -f', { silent: true });

    // Remove unused volumes
    await exec('docker volume prune -f', { silent: true });

    // Get reclaimed space
    const dfResult = await exec('docker system df --format "{{.Reclaimable}}"', { silent: true });
    const reclaimable = dfResult.stdout?.trim().split('\n')[0] || 'unknown';

    spinner.succeed(`Docker cleaned (${reclaimable} reclaimable)`);
  } catch (error) {
    spinner.warn(`Docker clean failed: ${error}`);
  }
}
