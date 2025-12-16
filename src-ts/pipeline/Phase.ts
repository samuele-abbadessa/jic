/**
 * Phase Interface for JIC CLI Pipeline
 *
 * Phases are units of work that run on modules. Examples:
 * - BuildPhase: Runs the build command for a module
 * - DockerBuildPhase: Builds Docker images
 * - DeployPhase: Deploys to AWS
 */

import type { ResolvedModule } from '../core/types/module.js';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';

// ============================================================================
// Phase Result Types
// ============================================================================

/**
 * Result of a single phase execution on a module
 */
export interface PhaseResult {
  /** Module name */
  module: string;
  /** Phase name */
  phase: string;
  /** Whether the phase succeeded */
  success: boolean;
  /** Duration in milliseconds */
  duration: number;
  /** Error if failed */
  error?: Error;
  /** Whether it was skipped */
  skipped?: boolean;
  /** Skip reason if skipped */
  skipReason?: string;
  /** Additional output/data from the phase */
  output?: string;
}

/**
 * Options passed to phase execution
 */
export interface PhaseOptions {
  /** Skip tests during build */
  skipTests?: boolean;
  /** Also build Docker image */
  docker?: boolean;
  /** Production mode */
  production?: boolean;
  /** Clean before build */
  clean?: boolean;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Custom phase-specific options */
  [key: string]: unknown;
}

// ============================================================================
// Phase Interface
// ============================================================================

/**
 * Interface for pipeline phases
 *
 * A phase is a unit of work that can be executed on a module.
 * Phases are composable and can be chained in a Pipeline.
 */
export interface Phase {
  /** Unique identifier for the phase */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Check if this phase should run for a module
   * @param module The module to check
   * @param ctx Execution context
   * @returns True if the phase should run
   */
  shouldRun(module: ResolvedModule, ctx: IExecutionContext): boolean;

  /**
   * Execute the phase on a module
   * @param module The module to run on
   * @param ctx Execution context
   * @param options Phase options
   * @returns Phase result
   */
  execute(
    module: ResolvedModule,
    ctx: IExecutionContext,
    options: PhaseOptions
  ): Promise<PhaseResult>;

  /**
   * Optional: Get a skip reason if shouldRun returns false
   */
  getSkipReason?(module: ResolvedModule, ctx: IExecutionContext): string;
}

// ============================================================================
// Abstract Base Phase
// ============================================================================

/**
 * Abstract base class for phases with common functionality
 */
export abstract class BasePhase implements Phase {
  abstract readonly name: string;
  abstract readonly description: string;

  abstract shouldRun(module: ResolvedModule, ctx: IExecutionContext): boolean;

  abstract execute(
    module: ResolvedModule,
    ctx: IExecutionContext,
    options: PhaseOptions
  ): Promise<PhaseResult>;

  getSkipReason(module: ResolvedModule, _ctx: IExecutionContext): string {
    return `Phase ${this.name} not applicable for ${module.name}`;
  }

  /**
   * Create a success result
   */
  protected success(module: ResolvedModule, duration: number, output?: string): PhaseResult {
    return {
      module: module.name,
      phase: this.name,
      success: true,
      duration,
      output,
    };
  }

  /**
   * Create a failure result
   */
  protected failure(
    module: ResolvedModule,
    duration: number,
    error: Error,
    output?: string
  ): PhaseResult {
    return {
      module: module.name,
      phase: this.name,
      success: false,
      duration,
      error,
      output,
    };
  }

  /**
   * Create a skipped result
   */
  protected skipped(module: ResolvedModule, reason: string): PhaseResult {
    return {
      module: module.name,
      phase: this.name,
      success: true, // Skipped is considered success
      duration: 0,
      skipped: true,
      skipReason: reason,
    };
  }
}
