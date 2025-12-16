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
 *   jic build --parallel         # Build in parallel
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { Pipeline } from '../pipeline/Pipeline.js';
import { BuildPhase, DockerBuildPhase, CleanPhase } from '../pipeline/phases/BuildPhase.js';
import { BuildError, withErrorHandling } from '../core/errors/index.js';

// ============================================================================
// Build Command Options
// ============================================================================

interface BuildOptions {
  /** Build Docker images */
  docker?: boolean;
  /** Skip tests during build */
  skipTests?: boolean;
  /** Build in parallel */
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
    .description('Build modules')
    .argument('[modules...]', 'Modules to build (names, aliases, or @groups)')
    .option('--docker', 'Also build Docker images')
    .option('--skip-tests', 'Skip test execution')
    .option('--parallel', 'Build modules in parallel')
    .option('--clean', 'Clean before building')
    .option('-t, --type <type>', 'Build only modules of specific type (java-service, flux-client, etc.)')
    .option('--skip-flux', 'Skip flux client builds')
    .option('--skip-java', 'Skip Java service builds')
    .option('--skip-node', 'Skip Node.js service builds')
    .option('--skip-frontend', 'Skip frontend build')
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
  // Resolve modules
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

  // Sort modules by dependency order (flux clients first, then services, then frontend)
  modules = sortByDependencyOrder(modules);

  // Show what we're building
  ctx.output.header('Build');
  ctx.output.keyValue('Modules', modules.map((m) => m.name).join(', '));
  ctx.output.keyValue('Options', formatOptions(options));
  ctx.output.newline();

  // Build phases list
  const phases = [];

  if (options.clean) {
    phases.push(new CleanPhase());
  }

  phases.push(new BuildPhase());

  if (options.docker) {
    phases.push(new DockerBuildPhase());
  }

  // Create and execute pipeline
  const pipeline = new Pipeline({
    phases,
    modules,
    parallel: options.parallel ?? false,
    failStrategy: ctx.failStrategy,
    phaseOptions: {
      skipTests: options.skipTests,
      docker: options.docker,
      clean: options.clean,
    },
    showProgress: true,
  });

  const result = await pipeline.execute(ctx);
  pipeline.printSummary(ctx, result);

  if (!result.success) {
    throw new BuildError(`Build failed: ${result.summary.failed} module(s) failed`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sort modules by dependency order
 * Order: flux-clients -> java-services -> node-services -> frontend
 */
function sortByDependencyOrder(modules: ReturnType<IExecutionContext['resolveModules']>): typeof modules {
  const typeOrder: Record<string, number> = {
    'lambda-layer': 0,
    'flux-client': 1,
    'java-service': 2,
    'node-service': 3,
    'lambda-functions': 4,
    frontend: 5,
  };

  return [...modules].sort((a, b) => {
    const orderA = typeOrder[a.type] ?? 99;
    const orderB = typeOrder[b.type] ?? 99;
    return orderA - orderB;
  });
}

/**
 * Format options for display
 */
function formatOptions(options: BuildOptions): string {
  const parts: string[] = [];

  if (options.docker) parts.push('docker');
  if (options.skipTests) parts.push('skip-tests');
  if (options.parallel) parts.push('parallel');
  if (options.clean) parts.push('clean');
  if (options.type) parts.push(`type=${options.type}`);

  return parts.length > 0 ? parts.join(', ') : 'default';
}
