/**
 * Build Phase Implementation
 *
 * Executes the build command for a module based on its configuration.
 * Supports all module types: java-service, flux-client, node-service, frontend, etc.
 */

import type { ResolvedModule } from '../../core/types/module.js';
import type { IExecutionContext } from '../../core/context/ExecutionContext.js';
import { BasePhase, type PhaseOptions, type PhaseResult } from '../Phase.js';
import { execInModule } from '../../core/utils/shell.js';
import { isBuildable } from '../../core/types/module.js';

/**
 * Build Phase
 *
 * Runs the configured build command for modules that have a build configuration.
 */
export class BuildPhase extends BasePhase {
  readonly name = 'build';
  readonly description = 'Build modules';

  /**
   * Check if module has a build command
   */
  shouldRun(module: ResolvedModule, _ctx: IExecutionContext): boolean {
    return isBuildable(module) && !!module.resolvedBuild?.command;
  }

  getSkipReason(module: ResolvedModule, _ctx: IExecutionContext): string {
    if (!isBuildable(module)) {
      return `Module ${module.name} is not buildable`;
    }
    if (!module.resolvedBuild?.command) {
      return `No build command configured for ${module.name}`;
    }
    return `Build not applicable for ${module.name}`;
  }

  /**
   * Execute build for a module
   */
  async execute(
    module: ResolvedModule,
    ctx: IExecutionContext,
    options: PhaseOptions
  ): Promise<PhaseResult> {
    const startTime = Date.now();
    const buildConfig = module.resolvedBuild;

    if (!buildConfig?.command) {
      return this.skipped(module, 'No build command configured');
    }

    // Create spinner for progress
    const spinner = ctx.output.spinner(`Building ${module.name}`);
    spinner.start();

    try {
      let command = buildConfig.command;

      // Handle skip tests option for Maven builds
      if (options.skipTests && command.includes('mvn')) {
        if (!command.includes('-DskipTests')) {
          command += ' -DskipTests=true -Dmaven.test.skip=true';
        }
      }

      // Show command in verbose mode
      if (ctx.verbose) {
        ctx.output.info(`${module.name}: ${command}`);
      }

      // Run pre-build command if configured
      if (buildConfig.preBuild) {
        if (ctx.verbose) {
          ctx.output.info(`${module.name} pre-build: ${buildConfig.preBuild}`);
        }
        await execInModule(module, buildConfig.preBuild, {
          silent: !ctx.verbose,
          verbose: ctx.verbose,
          dryRun: ctx.dryRun,
          env: buildConfig.env,
        });
      }

      // Dry run handling
      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${command}`);
        return this.success(module, Date.now() - startTime, `[dry-run] ${command}`);
      }

      // Execute build command
      await execInModule(module, command, {
        silent: !ctx.verbose,
        verbose: ctx.verbose,
        env: buildConfig.env,
      });

      const duration = Date.now() - startTime;
      spinner.succeed(`${module.name} (${Math.round(duration / 1000)}s)`);

      // Run post-build command if configured
      if (buildConfig.postBuild) {
        if (ctx.verbose) {
          ctx.output.info(`${module.name} post-build: ${buildConfig.postBuild}`);
        }
        await execInModule(module, buildConfig.postBuild, {
          silent: !ctx.verbose,
          verbose: ctx.verbose,
          env: buildConfig.env,
        });
      }

      return this.success(module, duration);
    } catch (error) {
      const duration = Date.now() - startTime;
      spinner.fail(`${module.name}: Build failed`);

      // Show error details
      if (error instanceof Error) {
        const execError = error as Error & { stderr?: string; stdout?: string; command?: string };

        if (execError.stderr) {
          ctx.output.error(`\n${execError.stderr}`);
        } else if (execError.message) {
          ctx.output.error(`\n${execError.message}`);
        }

        if (ctx.verbose) {
          if (execError.stdout) {
            ctx.output.info('\nBuild output:');
            console.log(execError.stdout);
          }
          if (execError.command) {
            ctx.output.info(`\nFailed command: ${execError.command}`);
          }
        }
      }

      return this.failure(
        module,
        duration,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

/**
 * Docker Build Phase
 *
 * Builds Docker images for modules that have Docker configuration.
 */
export class DockerBuildPhase extends BasePhase {
  readonly name = 'docker-build';
  readonly description = 'Build Docker images';

  /**
   * Check if module has a Docker build command
   */
  shouldRun(module: ResolvedModule, _ctx: IExecutionContext): boolean {
    return isBuildable(module) && !!module.resolvedBuild?.dockerCommand;
  }

  getSkipReason(module: ResolvedModule, _ctx: IExecutionContext): string {
    if (!isBuildable(module)) {
      return `Module ${module.name} is not buildable`;
    }
    if (!module.resolvedBuild?.dockerCommand) {
      return `No Docker build command configured for ${module.name}`;
    }
    return `Docker build not applicable for ${module.name}`;
  }

  /**
   * Execute Docker build for a module
   */
  async execute(
    module: ResolvedModule,
    ctx: IExecutionContext,
    options: PhaseOptions
  ): Promise<PhaseResult> {
    const startTime = Date.now();
    const buildConfig = module.resolvedBuild;

    if (!buildConfig?.dockerCommand) {
      return this.skipped(module, 'No Docker build command configured');
    }

    // Create spinner for progress
    const spinner = ctx.output.spinner(`Building Docker image for ${module.name}`);
    spinner.start();

    try {
      let command = buildConfig.dockerCommand;

      // Handle skip tests option for Maven builds
      if (options.skipTests && command.includes('mvn')) {
        if (!command.includes('-DskipTests')) {
          command += ' -DskipTests=true -Dmaven.test.skip=true';
        }
      }

      // Show command in verbose mode
      if (ctx.verbose) {
        ctx.output.info(`${module.name}: ${command}`);
      }

      // Dry run handling
      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${command}`);
        return this.success(module, Date.now() - startTime, `[dry-run] ${command}`);
      }

      // Execute Docker build command
      await execInModule(module, command, {
        silent: !ctx.verbose,
        verbose: ctx.verbose,
        env: buildConfig.env,
      });

      const duration = Date.now() - startTime;
      const imageName = buildConfig.dockerImage || module.name;
      spinner.succeed(`${module.name} -> ${imageName} (${Math.round(duration / 1000)}s)`);

      return this.success(module, duration, `Image: ${imageName}`);
    } catch (error) {
      const duration = Date.now() - startTime;
      spinner.fail(`${module.name}: Docker build failed`);

      // Show error details
      if (error instanceof Error) {
        const execError = error as Error & { stderr?: string; stdout?: string };
        if (execError.stderr) {
          ctx.output.error(`\n${execError.stderr}`);
        } else {
          ctx.output.error(`\n${error.message}`);
        }
      }

      return this.failure(
        module,
        duration,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

/**
 * Clean Phase
 *
 * Cleans build artifacts before building.
 */
export class CleanPhase extends BasePhase {
  readonly name = 'clean';
  readonly description = 'Clean build artifacts';

  /**
   * Check if module has a clean command
   */
  shouldRun(module: ResolvedModule, _ctx: IExecutionContext): boolean {
    return isBuildable(module) && !!module.resolvedBuild?.cleanCommand;
  }

  getSkipReason(module: ResolvedModule, _ctx: IExecutionContext): string {
    if (!module.resolvedBuild?.cleanCommand) {
      return `No clean command configured for ${module.name}`;
    }
    return `Clean not applicable for ${module.name}`;
  }

  /**
   * Execute clean for a module
   */
  async execute(
    module: ResolvedModule,
    ctx: IExecutionContext,
    _options: PhaseOptions
  ): Promise<PhaseResult> {
    const startTime = Date.now();
    const cleanCommand = module.resolvedBuild?.cleanCommand;

    if (!cleanCommand) {
      return this.skipped(module, 'No clean command configured');
    }

    const spinner = ctx.output.spinner(`Cleaning ${module.name}`);
    spinner.start();

    try {
      if (ctx.verbose) {
        ctx.output.info(`${module.name}: ${cleanCommand}`);
      }

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${cleanCommand}`);
        return this.success(module, Date.now() - startTime, `[dry-run] ${cleanCommand}`);
      }

      await execInModule(module, cleanCommand, {
        silent: !ctx.verbose,
        verbose: ctx.verbose,
      });

      const duration = Date.now() - startTime;
      spinner.succeed(`${module.name} cleaned`);

      return this.success(module, duration);
    } catch (error) {
      const duration = Date.now() - startTime;
      spinner.fail(`${module.name}: Clean failed`);

      return this.failure(
        module,
        duration,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
