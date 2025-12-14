/**
 * Configuration loader and manager
 *
 * Handles loading, merging, and validating configuration files:
 * - jic.config.json (project config, version controlled)
 * - jic.local.json (local overrides, git-ignored)
 * - jic.state.json (runtime state, git-ignored)
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { constants } from 'fs';
import { mergeWith, isArray } from 'lodash-es';

const CONFIG_FILENAME = 'jic.config.json';
const LOCAL_CONFIG_FILENAME = 'jic.local.json';
const STATE_FILENAME = 'jic.state.json';

/**
 * Find the project root by looking for jic.config.json
 */
async function findProjectRoot(startDir = process.cwd()) {
  let currentDir = startDir;
  const root = dirname(currentDir);

  while (currentDir !== root) {
    const configPath = join(currentDir, CONFIG_FILENAME);
    try {
      await access(configPath, constants.R_OK);
      return currentDir;
    } catch {
      currentDir = dirname(currentDir);
    }
  }

  return null;
}

/**
 * Load a JSON file, returning null if it doesn't exist
 */
async function loadJsonFile(filepath) {
  try {
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to parse ${filepath}: ${error.message}`);
  }
}

/**
 * Save a JSON file
 */
async function saveJsonFile(filepath, data) {
  const content = JSON.stringify(data, null, 2);
  await writeFile(filepath, content, 'utf-8');
}

/**
 * Custom merge function that replaces arrays instead of merging them
 */
function customMerge(objValue, srcValue) {
  if (isArray(objValue)) {
    return srcValue;
  }
}

/**
 * Load and merge all configuration files
 */
export async function loadConfig(options = {}) {
  const configPath = options.config || process.env.JIC_CONFIG;
  let projectRoot;
  let projectConfig;

  if (configPath) {
    // Use specified config file
    projectConfig = await loadJsonFile(configPath);
    if (!projectConfig) {
      throw new Error(`Configuration file not found: ${configPath}`);
    }
    projectRoot = dirname(configPath);
  } else {
    // Find project root
    projectRoot = await findProjectRoot();
    if (!projectRoot) {
      // Return minimal config for init command
      return {
        projectRoot: process.cwd(),
        isInitialized: false,
        modules: {},
        groups: {},
        aws: {},
        defaults: {}
      };
    }

    // Load project config
    projectConfig = await loadJsonFile(join(projectRoot, CONFIG_FILENAME));
    if (!projectConfig) {
      throw new Error(`Configuration file not found in ${projectRoot}`);
    }
  }

  // Load local config (optional)
  const localConfig = await loadJsonFile(join(projectRoot, LOCAL_CONFIG_FILENAME)) || {};

  // Load state (optional)
  const state = await loadJsonFile(join(projectRoot, STATE_FILENAME)) || {
    version: '1.0.0',
    sessions: {},
    deployVersions: { dev: {}, prod: {} },
    buildCache: {}
  };

  // Merge configurations
  const config = mergeWith({}, projectConfig, localConfig, customMerge);

  // Add runtime properties
  config.projectRoot = projectRoot;
  config.isInitialized = true;
  config.state = state;
  config.paths = {
    config: join(projectRoot, CONFIG_FILENAME),
    localConfig: join(projectRoot, LOCAL_CONFIG_FILENAME),
    state: join(projectRoot, STATE_FILENAME)
  };

  // Resolve module directories to absolute paths
  for (const [name, module] of Object.entries(config.modules || {})) {
    module.name = name;
    module.absolutePath = join(projectRoot, module.directory);
  }

  return config;
}

/**
 * Save state to file
 */
export async function saveState(config) {
  if (!config.isInitialized) {
    throw new Error('Cannot save state: project not initialized');
  }

  config.state.lastUpdated = new Date().toISOString();
  await saveJsonFile(config.paths.state, config.state);
}

/**
 * Get a module by name or alias
 */
export function getModule(config, nameOrAlias) {
  // Direct name match
  if (config.modules[nameOrAlias]) {
    return config.modules[nameOrAlias];
  }

  // Alias match
  for (const [name, module] of Object.entries(config.modules)) {
    if (module.aliases?.includes(nameOrAlias)) {
      return module;
    }
  }

  return null;
}

/**
 * Resolve module references (names, aliases, groups, globs)
 */
export function resolveModules(config, references) {
  if (!references || references.length === 0) {
    // Return all modules if no specific references
    return Object.values(config.modules);
  }

  const resolved = new Set();

  for (const ref of references) {
    // Group reference
    if (ref.startsWith('@')) {
      const groupModules = resolveGroup(config, ref);
      groupModules.forEach(m => resolved.add(m));
      continue;
    }

    // Glob pattern
    if (ref.includes('*')) {
      const pattern = new RegExp('^' + ref.replace(/\*/g, '.*') + '$');
      for (const [name, module] of Object.entries(config.modules)) {
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
      throw new Error(`Unknown module: ${ref}`);
    }
  }

  return Array.from(resolved);
}

/**
 * Resolve a group reference
 */
function resolveGroup(config, groupName) {
  const group = config.groups?.[groupName];
  if (!group) {
    throw new Error(`Unknown group: ${groupName}`);
  }

  const resolved = [];
  for (const ref of group) {
    if (ref === '*') {
      resolved.push(...Object.values(config.modules));
    } else if (ref.startsWith('@')) {
      resolved.push(...resolveGroup(config, ref));
    } else {
      resolved.push(...resolveModules(config, [ref]));
    }
  }

  return resolved;
}

/**
 * Get modules by type
 */
export function getModulesByType(config, type) {
  return Object.values(config.modules).filter(m => m.type === type);
}

/**
 * Get the next deploy version for a module
 */
export function getNextDeployVersion(config, moduleName, env = 'dev') {
  const current = config.state.deployVersions?.[env]?.[moduleName]?.version || 0;
  return current + 1;
}

/**
 * Update deploy version after successful deployment
 */
export function updateDeployVersion(config, moduleName, env, version, commit) {
  if (!config.state.deployVersions) {
    config.state.deployVersions = { dev: {}, prod: {} };
  }
  if (!config.state.deployVersions[env]) {
    config.state.deployVersions[env] = {};
  }

  config.state.deployVersions[env][moduleName] = {
    version,
    deployedAt: new Date().toISOString(),
    commit
  };
}

export default {
  loadConfig,
  saveState,
  getModule,
  resolveModules,
  getModulesByType,
  getNextDeployVersion,
  updateDeployVersion
};
