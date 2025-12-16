/**
 * Execution and Pipeline types for JIC CLI
 *
 * These types define the execution pipeline infrastructure that provides
 * a shared execution model for all commands.
 */

import type { ResolvedModule } from './module.js';
import type { FailStrategy, Environment } from './config.js';

// ============================================================================
// Execution Context Types
// ============================================================================

/**
 * Global CLI options parsed from command line
 */
export interface GlobalOptions {
  /** Configuration file path */
  config?: string;
  /** Environment (dev/staging/prod) */
  env: Environment;
  /** Dry run mode - preview without executing */
  dryRun: boolean;
  /** Skip confirmation prompts */
  yes: boolean;
  /** Output in JSON format */
  json: boolean;
  /** Minimal output */
  quiet: boolean;
  /** Detailed output */
  verbose: boolean;
  /** Disable colored output */
  noColor: boolean;
  /** Stop on first error */
  failFast: boolean;
  /** Continue despite errors */
  continueOnError: boolean;
}

/**
 * Computed fail strategy from options
 */
export function computeFailStrategy(options: GlobalOptions, defaultStrategy: FailStrategy): FailStrategy {
  if (options.failFast) return 'fail-fast';
  if (options.continueOnError) return 'continue';
  return defaultStrategy;
}

// ============================================================================
// Pipeline Types
// ============================================================================

/**
 * Phase execution context passed to each phase
 */
export interface PhaseContext {
  /** Module being processed */
  module: ResolvedModule;
  /** Environment */
  environment: Environment;
  /** Dry run mode */
  dryRun: boolean;
  /** Verbose mode */
  verbose: boolean;
  /** Results from previous phases */
  previousResults: Map<string, PhaseResult>;
  /** Shared data between phases */
  sharedData: Map<string, unknown>;
}

/**
 * Result of a single phase execution
 */
export interface PhaseResult {
  /** Whether the phase succeeded */
  success: boolean;
  /** Human-readable message */
  message?: string;
  /** Arbitrary result data */
  data?: Record<string, unknown>;
  /** Execution duration in milliseconds */
  duration: number;
  /** Error if failed */
  error?: Error;
  /** Warnings generated during execution */
  warnings?: string[];
}

/**
 * Phase definition
 */
export interface Phase {
  /** Phase name (unique identifier) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Execute the phase for a module */
  execute(context: PhaseContext): Promise<PhaseResult>;
  /** Optional: Check if phase should run for this module */
  shouldRun?(context: PhaseContext): boolean | Promise<boolean>;
  /** Optional: Rollback on failure */
  rollback?(context: PhaseContext): Promise<void>;
  /** Optional: Cleanup after execution (success or failure) */
  cleanup?(context: PhaseContext): Promise<void>;
}

/**
 * Pipeline options
 */
export interface PipelineOptions {
  /** Modules to process */
  modules: ResolvedModule[];
  /** Phases to execute in order */
  phases: Phase[];
  /** Run modules in parallel */
  parallel?: boolean;
  /** Maximum concurrent executions */
  maxConcurrency?: number;
  /** Failure handling strategy */
  failStrategy?: FailStrategy;
  /** Progress callback */
  onProgress?: (progress: PipelineProgress) => void;
  /** Phase start callback */
  onPhaseStart?: (phase: Phase, module: ResolvedModule) => void;
  /** Phase complete callback */
  onPhaseComplete?: (phase: Phase, module: ResolvedModule, result: PhaseResult) => void;
}

/**
 * Pipeline progress information
 */
export interface PipelineProgress {
  /** Current phase index (0-based) */
  currentPhase: number;
  /** Total number of phases */
  totalPhases: number;
  /** Current module index (0-based) */
  currentModule: number;
  /** Total number of modules */
  totalModules: number;
  /** Name of current phase */
  phaseName: string;
  /** Name of current module */
  moduleName: string;
  /** Percentage complete (0-100) */
  percentage: number;
}

/**
 * Result for a single module
 */
export interface PipelineModuleResult {
  /** Module name */
  moduleName: string;
  /** Whether all phases succeeded */
  success: boolean;
  /** Results per phase */
  phaseResults: Record<string, PhaseResult>;
  /** Total duration for this module */
  duration: number;
}

/**
 * Complete pipeline result
 */
export interface PipelineResult {
  /** Whether all modules succeeded */
  success: boolean;
  /** Results per module */
  moduleResults: Record<string, PipelineModuleResult>;
  /** Total duration */
  duration: number;
  /** Whether pipeline was aborted early */
  aborted: boolean;
  /** Summary statistics */
  summary: {
    totalModules: number;
    successfulModules: number;
    failedModules: number;
    skippedModules: number;
  };
}

// ============================================================================
// Command Types
// ============================================================================

/**
 * Base interface for all commands
 */
export interface Command {
  /** Command name */
  name: string;
  /** Command description */
  description: string;
  /** Command aliases */
  aliases?: string[];
}

/**
 * Command execution result
 */
export interface CommandResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Output message */
  message?: string;
  /** Result data (for JSON output) */
  data?: unknown;
}

// ============================================================================
// Spinner/Progress Types
// ============================================================================

/**
 * Spinner instance interface
 */
export interface Spinner {
  /** Start the spinner */
  start(text?: string): Spinner;
  /** Stop with success */
  succeed(text?: string): Spinner;
  /** Stop with failure */
  fail(text?: string): Spinner;
  /** Stop with warning */
  warn(text?: string): Spinner;
  /** Stop with info */
  info(text?: string): Spinner;
  /** Stop the spinner */
  stop(): Spinner;
  /** Update spinner text */
  text: string;
  /** Whether spinner is spinning */
  isSpinning: boolean;
}

// ============================================================================
// Process Management Types
// ============================================================================

/**
 * Managed process state
 */
export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/**
 * Managed process information
 */
export interface ManagedProcess {
  /** Process ID */
  pid: number;
  /** Process group ID */
  pgid: number;
  /** Module name */
  moduleName: string;
  /** Command that was executed */
  command: string;
  /** When the process started */
  startedAt: string;
  /** Service port (if applicable) */
  port?: number;
  /** Current status */
  status: ProcessStatus;
  /** Number of restarts */
  restartCount: number;
  /** Log file path */
  logFile?: string;
}

/**
 * Process spawn options
 */
export interface SpawnOptions {
  /** Run detached (background) */
  detach?: boolean;
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
}

/**
 * Process stop options
 */
export interface StopOptions {
  /** Timeout before force kill (ms) */
  timeout?: number;
  /** Suppress output */
  quiet?: boolean;
}
