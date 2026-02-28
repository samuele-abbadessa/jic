/**
 * Execution Context for JIC CLI
 *
 * Provides a unified interface for all commands to access:
 * - Configuration
 * - State management
 * - Module resolution
 * - Output helpers
 * - AWS configuration
 */

import type { LoadedConfig } from '../config/loader.js';
import type { ResolvedModule } from '../types/module.js';
import type { GlobalOptions } from '../types/execution.js';
import type { Environment, AwsEnvironmentConfig, KubernetesEnvironmentConfig, FailStrategy } from '../types/config.js';
import type { JicState, Session } from '../types/state.js';
import { Output, createOutput } from '../utils/output.js';
import { getModule, resolveModules, saveState } from '../config/loader.js';
import { computeFailStrategy } from '../types/execution.js';

// ============================================================================
// Context Interface
// ============================================================================

/**
 * Execution context interface
 */
export interface IExecutionContext {
  // Configuration
  readonly config: LoadedConfig;
  readonly projectRoot: string;
  readonly isInitialized: boolean;

  // Environment
  readonly env: Environment;
  readonly failStrategy: FailStrategy;

  // Execution options
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly json: boolean;
  readonly yes: boolean;

  // Output
  readonly output: Output;

  // Module resolution
  getModule(nameOrAlias: string): ResolvedModule | null;
  resolveModules(refs: string[]): ResolvedModule[];

  // State management
  readonly state: JicState;
  saveState(): Promise<void>;

  // Session
  readonly activeSession: Session | undefined;
  isSessionActive(): boolean;
  getSessionModules(): ResolvedModule[] | null;

  // AWS
  getAwsConfig(env?: Environment): AwsEnvironmentConfig;

  // Kubernetes
  getK8sConfig(env?: Environment): KubernetesEnvironmentConfig;
}

// ============================================================================
// Context Implementation
// ============================================================================

/**
 * Execution context class
 */
export class ExecutionContext implements IExecutionContext {
  readonly config: LoadedConfig;
  readonly env: Environment;
  readonly failStrategy: FailStrategy;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly json: boolean;
  readonly yes: boolean;
  readonly output: Output;

  constructor(config: LoadedConfig, options: GlobalOptions) {
    this.config = config;

    // Environment
    this.env = options.env ?? (config.defaults?.environment as Environment) ?? 'dev';

    // Fail strategy
    this.failStrategy = computeFailStrategy(
      options,
      config.defaults?.failStrategy ?? 'fail-fast'
    );

    // Execution options
    this.dryRun = options.dryRun ?? process.env.JIC_DRY_RUN === 'true';
    this.verbose = options.verbose ?? process.env.JIC_VERBOSE === 'true';
    this.quiet = options.quiet ?? false;
    this.json = options.json ?? false;
    this.yes = options.yes ?? false;

    // Create output instance with options
    this.output = createOutput({
      quiet: this.quiet,
      json: this.json,
      verbose: this.verbose,
      noColor: options.noColor,
    });

    // Set environment variable for verbose mode (used by error handler)
    if (this.verbose) {
      process.env.JIC_VERBOSE = 'true';
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  get projectRoot(): string {
    return this.config.projectRoot;
  }

  get isInitialized(): boolean {
    return this.config.isInitialized;
  }

  get state(): JicState {
    return this.config.state;
  }

  get activeSession(): Session | undefined {
    const sessionName = this.config.state.activeSession;
    if (!sessionName) return undefined;
    return this.config.state.sessions[sessionName];
  }

  // ==========================================================================
  // Module Resolution
  // ==========================================================================

  /**
   * Get a module by name or alias
   */
  getModule(nameOrAlias: string): ResolvedModule | null {
    return getModule(this.config, nameOrAlias);
  }

  /**
   * Resolve module references
   * If session is active and no refs provided, returns session modules
   */
  resolveModules(refs: string[]): ResolvedModule[] {
    // If session is active and no refs, use session modules
    if (refs.length === 0 && this.isSessionActive()) {
      const sessionModules = this.getSessionModules();
      if (sessionModules) {
        return sessionModules;
      }
    }

    return resolveModules(this.config, refs);
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Check if a session is currently active
   */
  isSessionActive(): boolean {
    return !!this.activeSession && this.activeSession.status === 'active';
  }

  /**
   * Get modules from active session
   */
  getSessionModules(): ResolvedModule[] | null {
    const session = this.activeSession;
    if (!session || session.status !== 'active') {
      return null;
    }

    return Object.keys(session.modules)
      .map((name) => this.getModule(name))
      .filter((m): m is ResolvedModule => m !== null);
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Save state to file
   */
  async saveState(): Promise<void> {
    await saveState(this.config);
  }

  // ==========================================================================
  // AWS Configuration
  // ==========================================================================

  /**
   * Get AWS configuration for an environment
   */
  getAwsConfig(env?: Environment): AwsEnvironmentConfig {
    const targetEnv = env ?? this.env;
    const awsConfig = this.config.aws;

    const envConfig = awsConfig[targetEnv as keyof typeof awsConfig] ?? {};

    return {
      profile: (envConfig as AwsEnvironmentConfig).profile ?? awsConfig.dev?.profile,
      accountId: (envConfig as AwsEnvironmentConfig).accountId,
      ecsCluster: (envConfig as AwsEnvironmentConfig).ecsCluster,
      ecrRegistry: (envConfig as AwsEnvironmentConfig).ecrRegistry,
      logGroup: (envConfig as AwsEnvironmentConfig).logGroup ?? `jic-${targetEnv}-logs`,
    };
  }

  // ==========================================================================
  // Kubernetes Configuration
  // ==========================================================================

  /**
   * Get Kubernetes configuration for an environment
   */
  getK8sConfig(env?: Environment): KubernetesEnvironmentConfig {
    const targetEnv = env ?? this.env;
    return this.config.kubernetes?.[targetEnv] ?? {};
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an execution context
 */
export function createContext(config: LoadedConfig, options: GlobalOptions): ExecutionContext {
  return new ExecutionContext(config, options);
}
