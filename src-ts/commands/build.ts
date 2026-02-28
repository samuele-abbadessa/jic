/**
 * Build Command
 *
 * Unified build command following the pattern: jic build [modules...] [options]
 *
 * Examples:
 *   jic build                    # Build all modules in dependency order
 *   jic build gws tms            # Build specific modules
 *   jic build @backend           # Build module group
 *   jic build @flux              # Build flux clients
 *   jic build --docker           # Build with Docker images
 *   jic build --parallel         # Build in parallel (respects dependency levels)
 *   jic build gws --with-deps    # Build gws and its dependencies
 *   jic build @flux --dependants # Build flux clients and all services that depend on them
 *   jic build --show-deps        # Show dependency tree without building
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ResolvedModule } from '../core/types/module.js';
import { Pipeline } from '../pipeline/Pipeline.js';
import { BuildPhase, DockerBuildPhase, CleanPhase } from '../pipeline/phases/BuildPhase.js';
import { BuildError, withErrorHandling } from '../core/errors/index.js';
import {
  expandDependencies,
  getDependants,
  getBuildOrder,
  formatDependencyTree,
  validateDependencies,
} from '../core/utils/dependencies.js';

// ============================================================================
// Build Command Options
// ============================================================================

interface BuildOptions {
  /** Build Docker images */
  docker?: boolean;
  /** Skip tests during build */
  skipTests?: boolean;
  /** Build in parallel (within dependency levels) */
  parallel?: boolean;
  /** Clean before build */
  clean?: boolean;
  /** Only build specific module types */
  type?: string;
  /** Skip flux client builds */
  skipFlux?: boolean;
  /** Skip Java service builds */
  skipJava?: boolean;
  /** Skip Node.js service builds */
  skipNode?: boolean;
  /** Skip frontend build */
  skipFrontend?: boolean;
  /** Include dependencies of specified modules */
  withDeps?: boolean;
  /** Also build modules that depend on the specified modules */
  dependants?: boolean;
  /** Show dependency tree without building */
  showDeps?: boolean;
}

// ============================================================================
// Build Command Registration
// ============================================================================

/**
 * Register the build command
 */
export function registerBuildCommand(program: Command, createContext: () => Promise<IExecutionContext>): void {
  program
    .command('build')
    .description('Build modules with dependency resolution')
    .argument('[modules...]', 'Modules to build (names, aliases, or @groups)')
    .option('--docker', 'Also build Docker images')
    .option('--skip-tests', 'Skip test execution')
    .option('--parallel', 'Build modules in parallel (within dependency levels)')
    .option('--clean', 'Clean before building')
    .option('-t, --type <type>', 'Build only modules of specific type (java-service, flux-client, etc.)')
    .option('--skip-flux', 'Skip flux client builds')
    .option('--skip-java', 'Skip Java service builds')
    .option('--skip-node', 'Skip Node.js service builds')
    .option('--skip-frontend', 'Skip frontend build')
    .option('-d, --with-deps', 'Include dependencies of specified modules')
    .option('-D, --dependants', 'Also build modules that depend on the specified modules')
    .option('--show-deps', 'Show dependency tree without building')
    .action(withErrorHandling(async (moduleRefs: string[], options: BuildOptions) => {
      const ctx = await createContext();
      await executeBuild(ctx, moduleRefs, options);
    }));
}

// ============================================================================
// Build Execution
// ============================================================================

/**
 * Execute build command
 */
async function executeBuild(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: BuildOptions
): Promise<void> {
  // Resolve initial modules
  let modules = ctx.resolveModules(moduleRefs);

  // Filter by type if specified
  if (options.type) {
    modules = modules.filter((m) => m.type === options.type);
    if (modules.length === 0) {
      ctx.output.warning(`No modules found with type: ${options.type}`);
      return;
    }
  }

  // Apply skip filters
  if (options.skipFlux) {
    modules = modules.filter((m) => m.type !== 'flux-client');
  }
  if (options.skipJava) {
    modules = modules.filter((m) => m.type !== 'java-service');
  }
  if (options.skipNode) {
    modules = modules.filter((m) => m.type !== 'node-service');
  }
  if (options.skipFrontend) {
    modules = modules.filter((m) => m.type !== 'frontend');
  }

  if (modules.length === 0) {
    ctx.output.warning('No modules to build');
    return;
  }

  // Track original modules before expansion
  const originalModules = [...modules];

  // Expand dependencies if requested
  if (options.withDeps) {
    modules = expandDependencies(modules, ctx.config);
    // Re-apply skip filters after expansion
    if (options.skipFlux) {
      modules = modules.filter((m) => m.type !== 'flux-client');
    }
    if (options.skipJava) {
      modules = modules.filter((m) => m.type !== 'java-service');
    }
    if (options.skipNode) {
      modules = modules.filter((m) => m.type !== 'node-service');
    }
    if (options.skipFrontend) {
      modules = modules.filter((m) => m.type !== 'frontend');
    }
  }

  // Add dependants if requested
  if (options.dependants) {
    const allDependants: ResolvedModule[] = [];
    for (const module of originalModules) {
      const deps = getDependants(module.name, ctx.config);
      for (const dep of deps) {
        if (!modules.some((m) => m.name === dep.name)) {
          allDependants.push(dep);
        }
      }
    }
    modules = [...modules, ...allDependants];
    // Re-apply skip filters after adding dependants
    if (options.skipFlux) {
      modules = modules.filter((m) => m.type !== 'flux-client');
    }
    if (options.skipJava) {
      modules = modules.filter((m) => m.type !== 'java-service');
    }
    if (options.skipNode) {
      modules = modules.filter((m) => m.type !== 'node-service');
    }
    if (options.skipFrontend) {
      modules = modules.filter((m) => m.type !== 'frontend');
    }
  }

  // Validate dependencies
  const warnings = validateDependencies(modules, ctx.config);
  for (const warning of warnings) {
    ctx.output.warning(warning);
  }

  // Handle --show-deps: display dependency tree and exit
  if (options.showDeps) {
    ctx.output.header('Dependency Tree');
    const tree = formatDependencyTree(modules, ctx.config, true);
    console.log(tree);
    return;
  }

  // Get build order respecting dependencies
  const buildLevels = getBuildOrder(modules, ctx.config, false);

  // Show what we're building
  ctx.output.header('Build');
  ctx.output.keyValue('Modules', modules.map((m) => m.name).join(', '));
  if (options.withDeps) {
    const added = modules.filter((m) => !originalModules.some((o) => o.name === m.name));
    if (added.length > 0) {
      ctx.output.keyValue('Dependencies added', added.map((m) => m.name).join(', '));
    }
  }
  if (options.dependants) {
    const added = modules.filter((m) => !originalModules.some((o) => o.name === m.name));
    if (added.length > 0) {
      ctx.output.keyValue('Dependants added', added.map((m) => m.name).join(', '));
    }
  }
  ctx.output.keyValue('Build levels', buildLevels.length.toString());
  ctx.output.keyValue('Options', formatOptions(options));
  ctx.output.newline();

  // Show build order in verbose mode
  if (ctx.verbose) {
    ctx.output.info('Build order:');
    for (const level of buildLevels) {
      const parallel = level.canParallelize && options.parallel ? ' (parallel)' : '';
      ctx.output.info(`  Level ${level.level}${parallel}: ${level.modules.map((m) => m.name).join(', ')}`);
    }
    ctx.output.newline();
  }

  // Execute builds level by level
  let totalFailed = 0;
  let totalSucceeded = 0;
  let totalSkipped = 0;

  for (const level of buildLevels) {
    if (ctx.verbose) {
      ctx.output.info(`Building level ${level.level}: ${level.modules.map((m) => m.name).join(', ')}`);
    }

    // Build phases list
    const phases = [];

    if (options.clean) {
      phases.push(new CleanPhase());
    }

    phases.push(new BuildPhase());

    if (options.docker) {
      phases.push(new DockerBuildPhase());
    }

    // Create and execute pipeline for this level
    const pipeline = new Pipeline({
      phases,
      modules: level.modules,
      parallel: (options.parallel ?? false) && level.canParallelize,
      failStrategy: ctx.failStrategy,
      phaseOptions: {
        skipTests: options.skipTests,
        docker: options.docker,
        clean: options.clean,
      },
      showProgress: true,
    });

    const result = await pipeline.execute(ctx);

    totalSucceeded += result.summary.successful;
    totalFailed += result.summary.failed;
    totalSkipped += result.summary.skipped;

    // If fail-fast and we had failures, stop here
    if (!result.success && ctx.failStrategy === 'fail-fast') {
      pipeline.printSummary(ctx, result);
      throw new BuildError(`Build failed at level ${level.level}: ${result.summary.failed} module(s) failed`);
    }
  }

  // Print final summary
  ctx.output.newline();
  ctx.output.header('Build Summary');
  ctx.output.keyValue('Succeeded', totalSucceeded.toString());
  ctx.output.keyValue('Failed', totalFailed.toString());
  ctx.output.keyValue('Skipped', totalSkipped.toString());

  if (totalFailed > 0) {
    throw new BuildError(`Build failed: ${totalFailed} module(s) failed`);
  }

  ctx.output.success('Build completed successfully');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format options for display
 */
function formatOptions(options: BuildOptions): string {
  const parts: string[] = [];

  if (options.docker) parts.push('docker');
  if (options.skipTests) parts.push('skip-tests');
  if (options.parallel) parts.push('parallel');
  if (options.clean) parts.push('clean');
  if (options.withDeps) parts.push('with-deps');
  if (options.dependants) parts.push('dependants');
  if (options.type) parts.push(`type=${options.type}`);

  return parts.length > 0 ? parts.join(', ') : 'default';
}
