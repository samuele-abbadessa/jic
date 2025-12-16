/**
 * Pipeline - Orchestrates Phase Execution
 *
 * The Pipeline runs phases across modules, handling:
 * - Sequential vs parallel execution
 * - Fail-fast vs continue-on-error strategies
 * - Progress tracking and reporting
 * - Result aggregation
 */

import type { ResolvedModule } from '../core/types/module.js';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { FailStrategy } from '../core/types/config.js';
import type { Phase, PhaseResult, PhaseOptions } from './Phase.js';
import { BuildError } from '../core/errors/index.js';
import { formatDuration } from '../core/utils/output.js';

// ============================================================================
// Pipeline Types
// ============================================================================

/**
 * Options for pipeline execution
 */
export interface PipelineOptions {
  /** Phases to run in order */
  phases: Phase[];
  /** Modules to run on */
  modules: ResolvedModule[];
  /** Run modules in parallel (default: false) */
  parallel?: boolean;
  /** Fail strategy (default: from context) */
  failStrategy?: FailStrategy;
  /** Phase-specific options */
  phaseOptions?: PhaseOptions;
  /** Show progress output */
  showProgress?: boolean;
}

/**
 * Result of pipeline execution
 */
export interface PipelineResult {
  /** Overall success */
  success: boolean;
  /** Total duration in milliseconds */
  duration: number;
  /** Results per phase */
  phases: PhaseResults;
  /** Summary statistics */
  summary: PipelineSummary;
}

/**
 * Results organized by phase
 */
export interface PhaseResults {
  [phaseName: string]: PhaseResult[];
}

/**
 * Summary statistics
 */
export interface PipelineSummary {
  /** Total modules processed */
  totalModules: number;
  /** Successful executions */
  successful: number;
  /** Failed executions */
  failed: number;
  /** Skipped executions */
  skipped: number;
  /** Per-phase summary */
  perPhase: {
    [phaseName: string]: {
      successful: number;
      failed: number;
      skipped: number;
    };
  };
}

// ============================================================================
// Pipeline Implementation
// ============================================================================

/**
 * Pipeline class for orchestrating phase execution
 */
export class Pipeline {
  private readonly phases: Phase[];
  private readonly modules: ResolvedModule[];
  private readonly parallel: boolean;
  private readonly failStrategy: FailStrategy;
  private readonly phaseOptions: PhaseOptions;
  private readonly showProgress: boolean;

  constructor(options: PipelineOptions) {
    this.phases = options.phases;
    this.modules = options.modules;
    this.parallel = options.parallel ?? false;
    this.failStrategy = options.failStrategy ?? 'fail-fast';
    this.phaseOptions = options.phaseOptions ?? {};
    this.showProgress = options.showProgress ?? true;
  }

  /**
   * Execute the pipeline
   */
  async execute(ctx: IExecutionContext): Promise<PipelineResult> {
    const startTime = Date.now();
    const results: PhaseResults = {};
    let overallSuccess = true;
    let aborted = false;

    // Initialize results for each phase
    for (const phase of this.phases) {
      results[phase.name] = [];
    }

    // Execute each phase in order
    for (const phase of this.phases) {
      if (aborted) break;

      // Show phase header
      if (this.showProgress && !ctx.quiet) {
        ctx.output.phase(phase.name, phase.description);
      }

      // Get applicable modules for this phase
      const applicableModules = this.modules.filter((m) => phase.shouldRun(m, ctx));

      if (applicableModules.length === 0) {
        if (this.showProgress && !ctx.quiet) {
          ctx.output.info(`No modules applicable for ${phase.name}`);
        }
        // Record skip results for non-applicable modules
        for (const module of this.modules) {
          const skipReason = phase.getSkipReason?.(module, ctx) ?? 'Not applicable';
          results[phase.name].push({
            module: module.name,
            phase: phase.name,
            success: true,
            duration: 0,
            skipped: true,
            skipReason,
          });
        }
        continue;
      }

      // Execute phase on modules
      const phaseResults = await this.executePhase(phase, applicableModules, ctx);
      results[phase.name] = phaseResults;

      // Check for failures
      const failures = phaseResults.filter((r) => !r.success && !r.skipped);
      if (failures.length > 0) {
        overallSuccess = false;

        if (this.failStrategy === 'fail-fast') {
          aborted = true;
          if (!ctx.quiet) {
            ctx.output.error(
              `Phase ${phase.name} failed for ${failures.map((f) => f.module).join(', ')}. Aborting.`
            );
          }
        }
      }

      // Show phase progress
      if (this.showProgress && !ctx.quiet) {
        const successful = phaseResults.filter((r) => r.success && !r.skipped).length;
        const skipped = phaseResults.filter((r) => r.skipped).length;
        ctx.output.progress(
          successful,
          applicableModules.length,
          `${phase.name} completed (${skipped} skipped, ${failures.length} failed)`
        );
      }
    }

    const duration = Date.now() - startTime;
    const summary = this.computeSummary(results);

    return {
      success: overallSuccess,
      duration,
      phases: results,
      summary,
    };
  }

  /**
   * Execute a single phase on modules (sequential or parallel)
   */
  private async executePhase(
    phase: Phase,
    modules: ResolvedModule[],
    ctx: IExecutionContext
  ): Promise<PhaseResult[]> {
    if (this.parallel) {
      return this.executeParallel(phase, modules, ctx);
    } else {
      return this.executeSequential(phase, modules, ctx);
    }
  }

  /**
   * Execute phase sequentially on modules
   */
  private async executeSequential(
    phase: Phase,
    modules: ResolvedModule[],
    ctx: IExecutionContext
  ): Promise<PhaseResult[]> {
    const results: PhaseResult[] = [];

    for (const module of modules) {
      // Check if we should skip due to shouldRun
      if (!phase.shouldRun(module, ctx)) {
        const skipReason = phase.getSkipReason?.(module, ctx) ?? 'Not applicable';
        results.push({
          module: module.name,
          phase: phase.name,
          success: true,
          duration: 0,
          skipped: true,
          skipReason,
        });
        continue;
      }

      // Execute phase
      const result = await this.executePhaseOnModule(phase, module, ctx);
      results.push(result);

      // Check fail-fast
      if (!result.success && this.failStrategy === 'fail-fast') {
        // Still return results collected so far
        break;
      }
    }

    return results;
  }

  /**
   * Execute phase in parallel on modules
   */
  private async executeParallel(
    phase: Phase,
    modules: ResolvedModule[],
    ctx: IExecutionContext
  ): Promise<PhaseResult[]> {
    const promises = modules.map(async (module) => {
      if (!phase.shouldRun(module, ctx)) {
        const skipReason = phase.getSkipReason?.(module, ctx) ?? 'Not applicable';
        return {
          module: module.name,
          phase: phase.name,
          success: true,
          duration: 0,
          skipped: true,
          skipReason,
        };
      }
      return this.executePhaseOnModule(phase, module, ctx);
    });

    return Promise.all(promises);
  }

  /**
   * Execute phase on a single module with error handling
   */
  private async executePhaseOnModule(
    phase: Phase,
    module: ResolvedModule,
    ctx: IExecutionContext
  ): Promise<PhaseResult> {
    try {
      return await phase.execute(module, ctx, this.phaseOptions);
    } catch (error) {
      // Handle unexpected errors
      return {
        module: module.name,
        phase: phase.name,
        success: false,
        duration: 0,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Compute summary statistics from results
   */
  private computeSummary(results: PhaseResults): PipelineSummary {
    const perPhase: PipelineSummary['perPhase'] = {};
    let totalSuccessful = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const [phaseName, phaseResults] of Object.entries(results)) {
      const successful = phaseResults.filter((r) => r.success && !r.skipped).length;
      const failed = phaseResults.filter((r) => !r.success).length;
      const skipped = phaseResults.filter((r) => r.skipped).length;

      perPhase[phaseName] = { successful, failed, skipped };
      totalSuccessful += successful;
      totalFailed += failed;
      totalSkipped += skipped;
    }

    return {
      totalModules: this.modules.length,
      successful: totalSuccessful,
      failed: totalFailed,
      skipped: totalSkipped,
      perPhase,
    };
  }

  /**
   * Print summary to output
   */
  printSummary(ctx: IExecutionContext, result: PipelineResult): void {
    if (ctx.quiet || ctx.json) {
      if (ctx.json) {
        ctx.output.json(result);
      }
      return;
    }

    ctx.output.header('Pipeline Summary');

    // Create summary table
    const rows: string[][] = [];
    for (const [phaseName, stats] of Object.entries(result.summary.perPhase)) {
      rows.push([phaseName, String(stats.successful), String(stats.failed), String(stats.skipped)]);
    }

    // Add separator and totals
    rows.push(['─────────────', '─────────', '──────', '───────']);
    rows.push([
      'Total',
      String(result.summary.successful),
      String(result.summary.failed),
      String(result.summary.skipped),
    ]);

    ctx.output.table(rows, {
      head: ['Phase', 'Successful', 'Failed', 'Skipped'],
    });

    ctx.output.newline();
    ctx.output.info(`Total time: ${formatDuration(result.duration)}`);

    if (!result.success) {
      ctx.output.newline();
      ctx.output.error(`Pipeline completed with ${result.summary.failed} failure(s)`);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and execute a pipeline
 */
export async function runPipeline(
  ctx: IExecutionContext,
  options: PipelineOptions
): Promise<PipelineResult> {
  const pipeline = new Pipeline({
    ...options,
    failStrategy: options.failStrategy ?? ctx.failStrategy,
  });

  const result = await pipeline.execute(ctx);
  pipeline.printSummary(ctx, result);

  if (!result.success && ctx.failStrategy === 'fail-fast') {
    throw new BuildError(`Pipeline failed: ${result.summary.failed} error(s)`);
  }

  return result;
}
