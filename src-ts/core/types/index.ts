/**
 * Core types for JIC CLI
 *
 * This module re-exports all types for convenient importing.
 *
 * @example
 * import type { JicConfig, ResolvedModule, PipelineOptions } from '@/core/types';
 */

// Configuration types
export type {
  // Enums and constants
  ModuleType,
  DeployType,
  Environment,
  FailStrategy,
  // Build
  BuildConfig,
  DockerBuildConfig,
  // Serve
  ServeConfig,
  // Deploy
  BaseDeployConfig,
  EcsDeployConfig,
  S3DeployConfig,
  LambdaDeployConfig,
  LambdaLayerDeployConfig,
  DeployConfig,
  // Lambda
  LambdaFunctionConfig,
  // Module
  BranchConfig,
  ModuleConfig,
  // Defaults
  DefaultsConfig,
  // AWS
  AwsEnvironmentConfig,
  AwsConfig,
  // Serve/Docker global
  InfraServiceConfig,
  ServeGlobalConfig,
  DockerConfig,
  // Build order
  BuildOrderEntry,
  // Project
  ProjectConfig,
  // Main config
  JicConfig,
  // Paths
  ConfigPaths,
} from './config.js';

// Module types
export type {
  ResolvedBuildConfig,
  ResolvedServeConfig,
  ResolvedDeployConfig,
  ResolvedModule,
  ModuleResolutionOptions,
  ModuleResolutionResult,
} from './module.js';

export {
  isServable,
  isBuildable,
  isDeployable,
  hasDockerSupport,
  isJavaService,
  isFluxClient,
  isFrontend,
  isNodeService,
  isLambdaLayer,
  isLambdaFunctions,
} from './module.js';

// Execution types
export type {
  GlobalOptions,
  PhaseContext,
  PhaseResult,
  Phase,
  PipelineOptions,
  PipelineProgress,
  PipelineModuleResult,
  PipelineResult,
  Command,
  CommandResult,
  Spinner,
  ProcessStatus,
  ManagedProcess,
  SpawnOptions,
  StopOptions,
} from './execution.js';

export { computeFailStrategy } from './execution.js';

// State types
export type {
  SessionStatus,
  SessionModuleState,
  MergedBranchRecord,
  SessionTemplate,
  Session,
  DeploymentStatus,
  DeploymentRecord,
  DeploymentState,
  InfrastructureState,
  ServeState,
  BuildCacheEntry,
  JicState,
} from './state.js';

export {
  createEmptyState,
  isSessionActive,
  getActiveSession,
} from './state.js';
