/**
 * Module types for JIC CLI
 *
 * These types represent modules after configuration has been loaded and resolved.
 * A ResolvedModule has all defaults merged in and paths resolved.
 */

import type {
  ModuleType,
  ModuleConfig,
  BuildConfig,
  ServeConfig,
  DeployConfig,
  Environment,
  LambdaFunctionConfig,
} from './config.js';

// ============================================================================
// Resolved Configuration Types
// ============================================================================

/**
 * Fully resolved build configuration
 * All optional fields from defaults have been merged in
 */
export interface ResolvedBuildConfig extends BuildConfig {
  /** Docker command (if applicable) */
  dockerCommand?: string;
  /** Docker image (if applicable) */
  dockerImage?: string;
  /** Docker registry (if applicable) */
  registry?: string;
}

/**
 * Fully resolved serve configuration
 */
export interface ResolvedServeConfig extends ServeConfig {
  /** Computed health check URL */
  healthCheckUrl?: string;
}

/**
 * Fully resolved deploy configuration per environment
 */
export type ResolvedDeployConfig = Record<Environment, DeployConfig | undefined>;

// ============================================================================
// Resolved Module
// ============================================================================

/**
 * A module with all configuration resolved
 *
 * This is the type used throughout the CLI after config loading.
 * It extends ModuleConfig with:
 * - Resolved name and absolute path
 * - Merged build/serve/deploy configs (defaults + overrides)
 */
export interface ResolvedModule extends Omit<ModuleConfig, 'build' | 'serve' | 'deploy'> {
  /** Module name (key from modules object) */
  name: string;

  /** Absolute path to module directory */
  absolutePath: string;

  /** Original module config (before resolution) */
  originalConfig: ModuleConfig;

  /** Fully resolved build config (defaults merged with overrides) */
  resolvedBuild?: ResolvedBuildConfig;

  /** Fully resolved serve config (defaults merged with overrides) */
  resolvedServe?: ResolvedServeConfig;

  /** Fully resolved deploy config per environment */
  resolvedDeploy?: ResolvedDeployConfig;

  /** Resolved Lambda function configs (for lambda-functions type) */
  resolvedFunctions?: Record<string, LambdaFunctionConfig>;
}

// ============================================================================
// Module Resolution
// ============================================================================

/**
 * Options for module resolution
 */
export interface ModuleResolutionOptions {
  /** Include dependencies of resolved modules */
  includeDependencies?: boolean;
  /** Sort by build order */
  sortByBuildOrder?: boolean;
  /** Filter by module type */
  filterByType?: ModuleType | ModuleType[];
  /** Only include servable modules */
  servableOnly?: boolean;
  /** Only include buildable modules */
  buildableOnly?: boolean;
  /** Only include deployable modules */
  deployableOnly?: boolean;
}

/**
 * Result of module resolution
 */
export interface ModuleResolutionResult {
  /** Resolved modules */
  modules: ResolvedModule[];
  /** Any warnings during resolution */
  warnings: string[];
  /** Modules that couldn't be resolved */
  unresolved: string[];
}

// ============================================================================
// Module Capabilities
// ============================================================================

/**
 * Check if a module is servable
 */
export function isServable(module: ResolvedModule): boolean {
  const nonServableTypes: ModuleType[] = ['flux-client', 'lambda-layer', 'lambda-functions'];
  if (nonServableTypes.includes(module.type)) {
    return false;
  }
  return !!(module.resolvedServe?.command || module.port);
}

/**
 * Check if a module is buildable
 */
export function isBuildable(module: ResolvedModule): boolean {
  return !!module.resolvedBuild?.command;
}

/**
 * Check if a module is deployable
 */
export function isDeployable(module: ResolvedModule): boolean {
  return !!(
    module.resolvedDeploy?.dev ||
    module.resolvedDeploy?.staging ||
    module.resolvedDeploy?.prod
  );
}

/**
 * Check if a module has Docker support
 */
export function hasDockerSupport(module: ResolvedModule): boolean {
  return !!(module.resolvedBuild?.dockerCommand && module.resolvedBuild?.dockerImage);
}

// ============================================================================
// Module Type Guards
// ============================================================================

/**
 * Check if module is a Java service
 */
export function isJavaService(module: ResolvedModule): boolean {
  return module.type === 'java-service';
}

/**
 * Check if module is a flux client
 */
export function isFluxClient(module: ResolvedModule): boolean {
  return module.type === 'flux-client';
}

/**
 * Check if module is a frontend
 */
export function isFrontend(module: ResolvedModule): boolean {
  return module.type === 'frontend';
}

/**
 * Check if module is a Node service
 */
export function isNodeService(module: ResolvedModule): boolean {
  return module.type === 'node-service';
}

/**
 * Check if module is a Lambda layer
 */
export function isLambdaLayer(module: ResolvedModule): boolean {
  return module.type === 'lambda-layer';
}

/**
 * Check if module is Lambda functions
 */
export function isLambdaFunctions(module: ResolvedModule): boolean {
  return module.type === 'lambda-functions';
}
