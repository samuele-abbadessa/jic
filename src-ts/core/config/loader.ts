/**
 * Configuration loader for JIC CLI
 *
 * Handles loading, merging, and validating configuration files:
 * - jic.config.json (project config, version controlled)
 * - jic.local.json (local overrides, git-ignored)
 * - jic.state.json (runtime state, git-ignored)
 *
 * Implements the configuration inheritance chain:
 * 1. Built-in defaults (from defaults.ts)
 * 2. Config defaults section
 * 3. Module-specific config
 * 4. Local overrides (jic.local.json)
 * 5. Environment variables (JIC_*)
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { constants } from 'fs';

import type {
  JicConfig,
  ModuleConfig,
  ConfigPaths,
  DefaultsConfig,
  BuildConfig,
  ServeConfig,
  DeployConfig,
  Environment,
  ModuleType,
} from '../types/config.js';
import type { ResolvedModule, ResolvedBuildConfig, ResolvedServeConfig } from '../types/module.js';
import type { JicState } from '../types/state.js';
import { createEmptyState } from '../types/state.js';
import { ConfigError } from '../errors/index.js';
import { builtInDefaults } from './defaults.js';
import { deepMerge, removeUndefined } from './merger.js';

// ============================================================================
// Constants
// ============================================================================

const CONFIG_FILENAME = 'jic.config.json';
const LOCAL_CONFIG_FILENAME = 'jic.local.json';
const STATE_FILENAME = 'jic.state.json';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for loading configuration
 */
export interface LoadOptions {
  /** Path to config file (overrides auto-discovery) */
  configPath?: string;
  /** Current working directory for auto-discovery */
  cwd?: string;
  /** Skip loading local config */
  skipLocal?: boolean;
  /** Skip loading state */
  skipState?: boolean;
}

/**
 * Loaded configuration with resolved modules and runtime info
 */
export interface LoadedConfig extends JicConfig {
  /** Project root directory */
  projectRoot: string;
  /** Whether project is initialized */
  isInitialized: boolean;
  /** Paths to config files */
  paths: ConfigPaths;
  /** Runtime state */
  state: JicState;
  /** Resolved modules (with defaults merged) */
  resolvedModules: Record<string, ResolvedModule>;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Find the project root by looking for jic.config.json
 */
async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  let currentDir = startDir;

  while (true) {
    const configPath = join(currentDir, CONFIG_FILENAME);
    try {
      await access(configPath, constants.R_OK);
      return currentDir;
    } catch {
      const parentDir = dirname(currentDir);
      // Stop at filesystem root
      if (parentDir === currentDir) {
        return null;
      }
      currentDir = parentDir;
    }
  }
}

/**
 * Load a JSON file, returning null if it doesn't exist
 */
async function loadJsonFile<T>(filepath: string): Promise<T | null> {
  try {
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new ConfigError(`Failed to parse ${filepath}: ${(error as Error).message}`);
  }
}

/**
 * Save a JSON file
 */
async function saveJsonFile(filepath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeFile(filepath, content, 'utf-8');
}

// ============================================================================
// Configuration Resolution
// ============================================================================

/**
 * Merge defaults with module-specific overrides for build config
 */
function resolveBuildConfig(
  module: ModuleConfig,
  defaults: DefaultsConfig
): ResolvedBuildConfig | undefined {
  const typeDefaults = defaults.build[module.type as keyof typeof defaults.build];

  if (!typeDefaults && !module.build?.command) {
    return undefined;
  }

  const merged = deepMerge<BuildConfig>(
    typeDefaults ?? {},
    removeUndefined(module.build ?? {})
  );

  return merged as ResolvedBuildConfig;
}

/**
 * Merge defaults with module-specific overrides for serve config
 */
function resolveServeConfig(
  module: ModuleConfig,
  defaults: DefaultsConfig,
  port?: number
): ResolvedServeConfig | undefined {
  const typeDefaults = defaults.serve[module.type as keyof typeof defaults.serve];

  if (!typeDefaults && !module.serve?.command) {
    return undefined;
  }

  const merged = deepMerge<ServeConfig>(
    typeDefaults ?? {},
    removeUndefined(module.serve ?? {})
  );

  // Compute health check URL if healthCheckPath is provided
  if (merged.healthCheckPath && port) {
    merged.healthCheck = `curl -sf --max-time 5 http://localhost:${port}${merged.healthCheckPath}`;
  }

  return merged as ResolvedServeConfig;
}

/**
 * Resolve deploy config for all environments
 */
function resolveDeployConfig(
  module: ModuleConfig,
  defaults: DefaultsConfig
): Record<Environment, DeployConfig | undefined> | undefined {
  const deployType = module.deploy?.type;

  if (!deployType && !module.deploy?.dev && !module.deploy?.prod) {
    return undefined;
  }

  const result: Record<Environment, DeployConfig | undefined> = {
    dev: undefined,
    staging: undefined,
    prod: undefined,
  };

  const environments: Environment[] = ['dev', 'staging', 'prod'];

  for (const env of environments) {
    const moduleEnvConfig = module.deploy?.[env];
    if (!moduleEnvConfig) continue;

    // Get deploy type defaults
    const deployTypeKey = moduleEnvConfig.type ?? deployType;
    if (!deployTypeKey) continue;

    const typeDefaults = defaults.deploy[deployTypeKey as keyof typeof defaults.deploy];
    const envDefaults = typeDefaults?.[env as keyof typeof typeDefaults];

    result[env] = deepMerge<DeployConfig>(
      envDefaults ?? {},
      removeUndefined(moduleEnvConfig)
    );
  }

  return result;
}

/**
 * Resolve a module with all defaults merged
 */
function resolveModule(
  name: string,
  config: ModuleConfig,
  projectRoot: string,
  defaults: DefaultsConfig,
  localOverrides?: Partial<ModuleConfig>
): ResolvedModule {
  // Merge local overrides into module config
  const merged = localOverrides
    ? deepMerge<ModuleConfig>(config, localOverrides)
    : config;

  return {
    ...merged,
    name,
    absolutePath: join(projectRoot, merged.directory),
    originalConfig: config,
    resolvedBuild: resolveBuildConfig(merged, defaults),
    resolvedServe: resolveServeConfig(merged, defaults, merged.port),
    resolvedDeploy: resolveDeployConfig(merged, defaults),
  };
}

// ============================================================================
// Main Loader
// ============================================================================

/**
 * Load and resolve all configuration files
 */
export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  let projectRoot: string | null;
  let configPath: string;

  // Determine project root
  if (options.configPath) {
    configPath = options.configPath;
    projectRoot = dirname(configPath);
  } else {
    projectRoot = await findProjectRoot(options.cwd);

    if (!projectRoot) {
      // Return minimal config for init command
      return {
        version: '2.0.0',
        project: { name: '', rootDir: '.' },
        defaults: builtInDefaults,
        modules: {},
        groups: {},
        aws: { region: 'eu-south-1', dev: {}, prod: {} },
        projectRoot: options.cwd ?? process.cwd(),
        isInitialized: false,
        paths: {
          config: join(options.cwd ?? process.cwd(), CONFIG_FILENAME),
          localConfig: join(options.cwd ?? process.cwd(), LOCAL_CONFIG_FILENAME),
          state: join(options.cwd ?? process.cwd(), STATE_FILENAME),
        },
        state: createEmptyState(),
        resolvedModules: {},
      };
    }

    configPath = join(projectRoot, CONFIG_FILENAME);
  }

  // Load main config
  const mainConfig = await loadJsonFile<JicConfig>(configPath);
  if (!mainConfig) {
    throw new ConfigError(`Configuration file not found: ${configPath}`);
  }

  // Load local config (optional)
  const localConfig = options.skipLocal
    ? null
    : await loadJsonFile<Partial<JicConfig>>(join(projectRoot, LOCAL_CONFIG_FILENAME));

  // Load state (optional)
  const state = options.skipState
    ? createEmptyState()
    : (await loadJsonFile<JicState>(join(projectRoot, STATE_FILENAME))) ?? createEmptyState();

  // Merge defaults: built-in <- config defaults
  const mergedDefaults = deepMerge<DefaultsConfig>(
    builtInDefaults,
    mainConfig.defaults ?? {}
  );

  // Resolve all modules
  const resolvedModules: Record<string, ResolvedModule> = {};

  for (const [name, moduleConfig] of Object.entries(mainConfig.modules ?? {})) {
    const localModuleOverrides = localConfig?.modules?.[name];
    resolvedModules[name] = resolveModule(
      name,
      moduleConfig,
      projectRoot,
      mergedDefaults,
      localModuleOverrides
    );
  }

  // Apply environment variable overrides
  applyEnvOverrides(resolvedModules);

  return {
    ...mainConfig,
    defaults: mergedDefaults,
    projectRoot,
    isInitialized: true,
    paths: {
      config: configPath,
      localConfig: join(projectRoot, LOCAL_CONFIG_FILENAME),
      state: join(projectRoot, STATE_FILENAME),
    },
    state,
    resolvedModules,
  };
}

/**
 * Apply environment variable overrides to resolved modules
 */
function applyEnvOverrides(_modules: Record<string, ResolvedModule>): void {
  // JIC_ENV overrides environment
  const envOverride = process.env.JIC_ENV;
  if (envOverride) {
    // This would be used at runtime, not stored in config
  }

  // Future: Add more env var support like JIC_VERBOSE, JIC_DRY_RUN, etc.
}

// ============================================================================
// Save Operations
// ============================================================================

/**
 * Save state to file
 */
export async function saveState(config: LoadedConfig): Promise<void> {
  if (!config.isInitialized) {
    throw new ConfigError('Cannot save state: project not initialized');
  }

  config.state.lastUpdated = new Date().toISOString();
  await saveJsonFile(config.paths.state, config.state);
}

/**
 * Save main config to file
 * Note: This modifies jic.config.json which is version controlled
 */
export async function saveConfig(config: LoadedConfig): Promise<void> {
  if (!config.isInitialized) {
    throw new ConfigError('Cannot save config: project not initialized');
  }

  // Create a clean copy without runtime properties
  const cleanConfig: JicConfig = {
    $schema: config.$schema,
    version: config.version,
    project: config.project,
    defaults: config.defaults,
    modules: {},
    groups: config.groups,
    buildOrder: config.buildOrder,
    aws: config.aws,
    docker: config.docker,
    serve: config.serve,
  };

  // Use original module configs (without resolved properties)
  for (const [name, module] of Object.entries(config.resolvedModules)) {
    cleanConfig.modules[name] = module.originalConfig;
  }

  await saveJsonFile(config.paths.config, cleanConfig);
}

// ============================================================================
// Module Resolution Helpers
// ============================================================================

/**
 * Get a module by name or alias
 */
export function getModule(config: LoadedConfig, nameOrAlias: string): ResolvedModule | null {
  // Direct name match
  if (config.resolvedModules[nameOrAlias]) {
    return config.resolvedModules[nameOrAlias];
  }

  // Alias match
  for (const module of Object.values(config.resolvedModules)) {
    if (module.aliases?.includes(nameOrAlias)) {
      return module;
    }
  }

  return null;
}

/**
 * Get modules by type
 */
export function getModulesByType(config: LoadedConfig, type: ModuleType): ResolvedModule[] {
  return Object.values(config.resolvedModules).filter((m) => m.type === type);
}

/**
 * Resolve module references (names, aliases, groups, globs)
 */
export function resolveModules(config: LoadedConfig, references: string[]): ResolvedModule[] {
  if (!references || references.length === 0) {
    // Return all modules if no specific references
    return Object.values(config.resolvedModules);
  }

  const resolved = new Set<ResolvedModule>();

  for (const ref of references) {
    // Group reference
    if (ref.startsWith('@')) {
      const groupModules = resolveGroup(config, ref);
      for (const m of groupModules) {
        resolved.add(m);
      }
      continue;
    }

    // Glob pattern
    if (ref.includes('*')) {
      const pattern = new RegExp('^' + ref.replace(/\*/g, '.*') + '$');
      for (const [name, module] of Object.entries(config.resolvedModules)) {
        if (pattern.test(name)) {
          resolved.add(module);
        }
      }
      continue;
    }

    // Direct name or alias
    const module = getModule(config, ref);
    if (module) {
      resolved.add(module);
    } else {
      throw new ConfigError(`Unknown module: ${ref}`);
    }
  }

  return Array.from(resolved);
}

/**
 * Resolve a group reference
 */
function resolveGroup(config: LoadedConfig, groupName: string): ResolvedModule[] {
  const group = config.groups?.[groupName];
  if (!group) {
    throw new ConfigError(`Unknown group: ${groupName}`);
  }

  const resolved: ResolvedModule[] = [];

  for (const ref of group) {
    if (ref === '*') {
      resolved.push(...Object.values(config.resolvedModules));
    } else if (ref.startsWith('@')) {
      resolved.push(...resolveGroup(config, ref));
    } else {
      resolved.push(...resolveModules(config, [ref]));
    }
  }

  return resolved;
}
